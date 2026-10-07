import { EmbConstant } from "./constants.js";
import { findNearestColorIndex } from "./thread.js";
import type { EmbThread } from "./thread.js";
import { EmbPattern } from "./pattern.js";
import type { Extents, Stitch } from "./pattern.js";
import { getThreadSet } from "./pecThreads.js";
import type { EncoderSettings } from "./encoder.js";
import { ByteWriter } from "./binaryWriter.js";
import { finiteExtents, truncateUtf8, writePec } from "./writePec.js";
import type { PecColorInfo } from "./writePec.js";

const {
  COMMAND_MASK,
  STITCH,
  JUMP,
  STOP,
  COLOR_CHANGE,
  COLOR_BREAK,
  SEW_TO,
  NEEDLE_AT,
  CONTINGENCY_SEQUIN_JUMP,
} = EmbConstant;

const PES_VERSION_1_SIGNATURE = "#PES0001";
const PES_VERSION_6_SIGNATURE = "#PES0060";
const MAX_PES_DELTA = 2047;
const encoder = new TextEncoder();

export interface PesWriteSettings extends EncoderSettings {
  /** Run the encoder first, splitting stitches longer than PES allows. Default true. */
  encode?: boolean;
  /** PES format version. Version 6 keeps exact thread colors and metadata. Default 6. */
  version?: 1 | 6;
}

/** Serializes a pattern as a Brother .pes file. */
export function writePes(
  source: EmbPattern,
  settings?: PesWriteSettings
): Uint8Array {
  const values: PesWriteSettings = { ...(settings ?? {}) };
  const version = values.version ?? 6;
  if (version !== 1 && version !== 6) {
    throw new RangeError(`writePes: unsupported PES version ${String(version)}`);
  }

  let normalized: EmbPattern;
  if (values.encode ?? true) {
    const encodeSettings: EncoderSettings = { ...values };
    if (encodeSettings.max_jump === undefined) {
      encodeSettings.max_jump = MAX_PES_DELTA;
    }
    if (encodeSettings.max_stitch === undefined) {
      encodeSettings.max_stitch = MAX_PES_DELTA;
    }
    if (encodeSettings.full_jump === undefined) encodeSettings.full_jump = true;
    if (encodeSettings.round === undefined) encodeSettings.round = true;
    if (encodeSettings.sequin_contingency === undefined) {
      encodeSettings.sequin_contingency = CONTINGENCY_SEQUIN_JUMP;
    }
    normalized = source.getNormalizedPattern(encodeSettings);
  } else {
    normalized = clonePattern(source);
  }

  preparePatternForPes(normalized);
  return version === 6 ? writeVersion6(normalized) : writeVersion1(normalized);
}

function clonePattern(source: EmbPattern): EmbPattern {
  const clone = new EmbPattern();
  clone.stitches = source.stitches.map(
    ([x, y, command]): Stitch => [x, y, command]
  );
  clone.threadlist.push(...source.threadlist);
  Object.assign(clone.extras, source.extras);
  clone._previousX = source._previousX;
  clone._previousY = source._previousY;
  return clone;
}

function preparePatternForPes(pattern: EmbPattern): void {
  pattern.fixColorCount();
  if (pattern.threadlist.length === 0) {
    pattern.addThread(pattern.getThreadOrFiller(0));
  }

  let threadIndex = 0;
  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    if (
      command === STITCH ||
      command === SEW_TO ||
      command === NEEDLE_AT
    ) {
      continue;
    }
    if (command === COLOR_CHANGE || command === COLOR_BREAK) {
      threadIndex += 1;
    } else if (command === STOP) {
      const thread = pattern.threadlist[threadIndex]!;
      if (thread === undefined) continue;
      pattern.threadlist.splice(threadIndex, 0, thread);
      stitch[2]! = COLOR_CHANGE;
      threadIndex += 1;
    }
  }
}

function writeVersion1(pattern: EmbPattern): Uint8Array {
  const out = new ByteWriter();
  out.writeBytes(encoder.encode(PES_VERSION_1_SIGNATURE));
  const offsetPosition = out.tell();
  out.writeUint32le(0);

  const extents = finiteExtents(pattern);
  const chart = getThreadSet();
  if (pattern.stitches.length === 0) {
    out.writeInt16le(1);
    out.writeInt16le(1);
    out.writeInt16le(0);
    out.writeUint16le(0);
    out.writeUint16le(0);
  } else {
    out.writeInt16le(1);
    out.writeInt16le(1);
    out.writeInt16le(1);
    out.writeUint16le(0xffff);
    out.writeUint16le(0);
    writePesBlocks(out, pattern, chart, extents);
  }

  patchPecOffset(out, offsetPosition);
  writePec(pattern, out);
  return out.toUint8Array();
}

function writeVersion6(pattern: EmbPattern): Uint8Array {
  const out = new ByteWriter();
  out.writeBytes(encoder.encode(PES_VERSION_6_SIGNATURE));
  const offsetPosition = out.tell();
  out.writeUint32le(0);

  const extents = finiteExtents(pattern);
  if (pattern.stitches.length === 0) {
    writePesHeaderV6(out, pattern, 0);
    out.writeUint16le(0);
    out.writeUint16le(0);
  } else {
    writePesHeaderV6(out, pattern, 1);
    out.writeUint16le(0xffff);
    out.writeUint16le(0);
    const blockInfo = writePesBlocks(out, pattern, pattern.threadlist, extents);
    out.writeUint32le(0);
    out.writeUint32le(0);
    for (let index = 0; index < blockInfo.colorLogCount; index++) {
      out.writeUint32le(index);
      out.writeUint32le(0);
    }
  }

  patchPecOffset(out, offsetPosition);
  const colorInfo = writePec(pattern, out);
  writePesAddendum(out, colorInfo);
  out.writeUint16le(0);
  return out.toUint8Array();
}

function patchPecOffset(out: ByteWriter, position: number): void {
  const pecPosition = out.tell();
  out.seek(position);
  out.writeUint32le(pecPosition);
  out.seek(pecPosition);
}

function writePesHeaderV6(
  out: ByteWriter,
  pattern: EmbPattern,
  distinctBlockObjects: number
): void {
  out.writeInt16le(1);
  out.writeBytes(encoder.encode("02"));
  for (const key of ["name", "category", "author", "keywords", "comments"]) {
    writePesString8(out, pattern.getMetadata(key));
  }
  for (const value of [0, 0, 100, 100, 0, 200, 200, 100, 100, 100, 7, 19, 1, 1, 0, 100, 1, 0]) {
    out.writeInt16le(value);
  }
  writePesString8(out, pattern.getMetadata("image_file"));
  for (const value of [1, 0, 0, 1, 0, 0]) out.writeFloat32le(value);
  out.writeUint16le(0);
  out.writeUint16le(0);
  out.writeUint16le(0);
  if (pattern.threadlist.length > 0xffff) {
    throw new RangeError("writePes: too many PES v6 threads");
  }
  out.writeUint16le(pattern.threadlist.length);
  for (const thread of pattern.threadlist) writePesThread(out, thread);
  out.writeInt16le(distinctBlockObjects);
}

function writePesThread(out: ByteWriter, thread: EmbThread): void {
  writePesString8(out, thread.catalog_number);
  out.writeUint8(thread.getRed());
  out.writeUint8(thread.getGreen());
  out.writeUint8(thread.getBlue());
  out.writeUint8(0);
  out.writeUint32le(0x0a);
  writePesString8(out, thread.description);
  writePesString8(out, thread.brand);
  writePesString8(out, thread.chart);
}

function writePesString8(out: ByteWriter, value: unknown): void {
  if (typeof value !== "string") {
    out.writeUint8(0);
    return;
  }
  const bytes = truncateUtf8(value, 255);
  out.writeUint8(bytes.length);
  out.writeBytes(bytes);
}

function writePesString16(out: ByteWriter, value: string): void {
  const bytes = truncateUtf8(value, 0xffff);
  out.writeUint16le(bytes.length);
  out.writeBytes(bytes);
}

interface PesBlockInfo {
  sectionCount: number;
  colorLogCount: number;
}

function writePesBlocks(
  out: ByteWriter,
  pattern: EmbPattern,
  chart: EmbThread[],
  extents: Extents
): PesBlockInfo {
  if (pattern.stitches.length === 0) return { sectionCount: 0, colorLogCount: 0 };

  const centerX = (extents.maxX + extents.minX) / 2;
  const centerY = (extents.maxY + extents.minY) / 2;
  const left = extents.minX - centerX;
  const top = extents.minY - centerY;
  const right = extents.maxX - centerX;
  const bottom = extents.maxY - centerY;

  writePesString16(out, "CEmbOne");
  const sectionCountPosition = writePesSewSegHeader(out, right - left, bottom - top);
  out.writeUint16le(0xffff);
  out.writeUint16le(0);

  writePesString16(out, "CSewSeg");
  const segmentInfo = writePesSewSegSegments(
    out,
    pattern,
    chart,
    left,
    bottom,
    centerX,
    centerY
  );
  const end = out.tell();
  out.seek(sectionCountPosition);
  out.writeUint16le(segmentInfo.sectionCount);
  out.seek(end);

  out.writeUint16le(0);
  out.writeUint16le(0);
  return {
    sectionCount: segmentInfo.sectionCount,
    colorLogCount: segmentInfo.colorLogCount,
  };
}

function writePesSewSegHeader(out: ByteWriter, width: number, height: number): number {
  for (let index = 0; index < 8; index++) out.writeUint16le(0);

  const translateX = 350 + 1300 / 2 - width / 2;
  const translateY = 100 + height + 1800 / 2 - height / 2;
  for (const value of [1, 0, 0, 1, translateX, translateY]) out.writeFloat32le(value);
  out.writeUint16le(1);
  out.writeUint16le(0);
  out.writeUint16le(0);
  out.writeInt16le(Math.trunc(width));
  out.writeInt16le(Math.trunc(height));
  out.writeBytes(new Array<number>(8).fill(0));
  const sectionCountPosition = out.tell();
  out.writeUint16le(0);
  return sectionCountPosition;
}

interface SegmentBlock {
  points: [number, number][];
  colorCode: number;
  flag: number;
}

function* getAsSegmentBlocks(
  pattern: EmbPattern,
  chart: EmbThread[]
): Generator<SegmentBlock> {
  let colorIndex = 0;
  let currentThread = pattern.getThreadOrFiller(colorIndex);
  colorIndex += 1;
  let colorCode = findNearestColorIndex(currentThread, chart);
  let stitchedX = 0;
  let stitchedY = 0;

  for (const commandBlock of pattern.getAsCommandBlocks()) {
    if (commandBlock.length === 0) continue;
    const points: [number, number][] = [];
    const command = commandBlock[0]![2]! & COMMAND_MASK;

    if (command === JUMP) {
      points.push([stitchedX, stitchedY]);
      const last = commandBlock[commandBlock.length - 1]!;
      points.push([last[0]!, last[1]!]);
      yield { points, colorCode, flag: 1 };
    } else if (command === COLOR_CHANGE) {
      currentThread = pattern.getThreadOrFiller(colorIndex);
      colorIndex += 1;
      colorCode = findNearestColorIndex(currentThread, chart);
    } else if (command === STITCH) {
      for (const stitch of commandBlock) {
        stitchedX = stitch[0]!;
        stitchedY = stitch[1]!;
        points.push([stitchedX, stitchedY]);
      }
      yield { points, colorCode, flag: 0 };
    }
  }
}

interface PesSegmentInfo {
  sectionCount: number;
  colorLogCount: number;
}

function writePesSewSegSegments(
  out: ByteWriter,
  pattern: EmbPattern,
  chart: EmbThread[],
  left: number,
  bottom: number,
  centerX: number,
  centerY: number
): PesSegmentInfo {
  let section = 0;
  const colorLog: [number, number][] = [];
  let previousColorCode = -1;
  let wrotePrevious = false;
  const adjustX = left + centerX;
  const adjustY = bottom + centerY;

  for (const segment of getAsSegmentBlocks(pattern, chart)) {
    if (wrotePrevious) out.writeUint16le(0x8003);
    if (previousColorCode !== segment.colorCode) {
      colorLog.push([section, segment.colorCode]);
      previousColorCode = segment.colorCode;
    }
    out.writeUint16le(segment.flag);
    out.writeUint16le(segment.colorCode);
    out.writeUint16le(segment.points.length);
    for (const [x, y] of segment.points) {
      out.writeInt16le(Math.trunc(x - adjustX));
      out.writeInt16le(Math.trunc(y - adjustY));
    }
    section += 1;
    wrotePrevious = true;
  }

  out.writeUint16le(colorLog.length);
  for (const [index, colorCode] of colorLog) {
    out.writeUint16le(index);
    out.writeUint16le(colorCode);
  }
  return {
    sectionCount: section,
    colorLogCount: colorLog.length,
  };
}

function writePesAddendum(out: ByteWriter, colorInfo: PecColorInfo): void {
  out.writeBytes(colorInfo.colorIndexList);
  out.writeBytes(
    new Array<number>(Math.max(0, 128 - colorInfo.colorIndexList.length)).fill(
      0x20
    )
  );
  out.writeBytes(new Array<number>(0x90 * colorInfo.rgbList.length).fill(0));
  for (const color of colorInfo.rgbList) out.writeInt24le(color);
}
