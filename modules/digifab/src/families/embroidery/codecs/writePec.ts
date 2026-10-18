import { EmbConstant } from "./constants.js";
import { findNearestColorIndex } from "./thread.js";
import type { EmbThread } from "./thread.js";
import type { EmbPattern, Extents, Stitch } from "./pattern.js";
import { getThreadSet } from "./pecThreads.js";
import { pyRound } from "./pyMath.js";
import { ByteWriter } from "./binaryWriter.js";

import { countOf } from "@cobblr/platform-contract/plural";
const { COMMAND_MASK, STITCH, JUMP, END, COLOR_CHANGE } = EmbConstant;

const JUMP_CODE = 0x10;
const TRIM_CODE = 0x20;
const PEC_ICON_WIDTH = 48;
const PEC_ICON_HEIGHT = 38;
const PEC_STRIDE = 6;
const PEC_HEADER_SIZE = 512;
const SPACE = 0x20;

const encoder = new TextEncoder();

function fromHex(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

const BLANK_GRAPHIC = Uint8Array.from(
  fromHex(
    "000000000000f0ffffffff0f080000000010040000000020020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040020000000040040000000020080000000010f0ffffffff0f000000000000"
  )
);

export interface PecColorInfo {
  colorIndexList: number[];
  rgbList: number[];
}

export function truncateUtf8(value: string, maxBytes: number): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const next = encoder.encode(character);
    if (bytes.length + next.length > maxBytes) break;
    bytes.push(...next);
  }
  return Uint8Array.from(bytes);
}

export function finiteExtents(pattern: EmbPattern): Extents {
  if (pattern.stitches.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return pattern.extents();
}

function sameThreadValue(a: EmbThread, b: EmbThread): boolean {
  return (
    (a.color & 0xffffff) === (b.color & 0xffffff) &&
    a.description === b.description &&
    a.catalog_number === b.catalog_number &&
    a.details === b.details &&
    a.brand === b.brand &&
    a.chart === b.chart &&
    a.weight === b.weight
  );
}

function buildUniquePalette(threadlist: EmbThread[]): number[] {
  const chart: (EmbThread | null)[] = getThreadSet();
  const uniqueThreads: EmbThread[] = [];
  for (const thread of threadlist) {
    if (!uniqueThreads.some((unique) => sameThreadValue(unique, thread))) {
      uniqueThreads.push(thread);
    }
  }

  const assignments: number[] = [];
  for (const thread of uniqueThreads) {
    const index = findNearestColorIndex(thread, chart);
    if (index < 0) {
      throw new RangeError(
        `writePes: a PEC palette supports at most ${countOf(chart.length, "unique thread")}`
      );
    }
    assignments.push(index);
    chart[index] = null;
  }

  return threadlist.map(
    (thread) => assignments[uniqueThreads.findIndex((unique) => sameThreadValue(unique, thread))]!
  );
}

export function writePec(pattern: EmbPattern, out: ByteWriter): PecColorInfo {
  const extents = finiteExtents(pattern);
  const palette = buildUniquePalette(pattern.threadlist);
  if (palette.length < 1 || palette.length > 255) {
    throw new RangeError("writePes: PES supports between 1 and 255 color blocks");
  }

  const pecStart = out.tell();
  const name = pattern.getMetadata("name");
  const label = new Uint8Array(16).fill(SPACE);
  label.set(truncateUtf8(typeof name === "string" ? name : "Untitled", 8));
  out.writeBytes(encoder.encode("LA:"));
  out.writeBytes(label);
  out.writeUint8(0x0d);
  out.writeBytes([...new Array<number>(12).fill(SPACE), 0xff, 0x00]);
  out.writeUint8(PEC_ICON_WIDTH / 8);
  out.writeUint8(PEC_ICON_HEIGHT);
  out.writeBytes(new Array<number>(12).fill(SPACE));
  const colorIndexList = [palette.length - 1, ...palette];
  out.writeBytes(colorIndexList);
  out.writeBytes(new Array<number>(pecStart + PEC_HEADER_SIZE - out.tell()).fill(SPACE));

  writePecBlock(pattern, out, extents);
  writePecGraphics(pattern, out, extents);
  return {
    colorIndexList,
    rgbList: pattern.threadlist.map((thread) => thread.color),
  };
}

function writePecBlock(pattern: EmbPattern, out: ByteWriter, extents: Extents): void {
  const blockStart = out.tell();
  out.writeBytes([0x00, 0x00]);
  out.writeInt24le(0);
  out.writeBytes([0x31, 0xff, 0xf0]);
  out.writeInt16le(pyRound(extents.maxX - extents.minX));
  out.writeInt16le(pyRound(extents.maxY - extents.minY));
  out.writeInt16le(0x1e0);
  out.writeInt16le(0x1b0);
  encodePecStitches(pattern, out);

  const blockEnd = out.tell();
  out.seek(blockStart + 2);
  out.writeInt24le(blockEnd - blockStart);
  out.seek(blockEnd);
}

function checkedDelta(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`writePes: stitch delta must be finite, got ${value}`);
  }
  const rounded = pyRound(value);
  if (rounded < -2048 || rounded > 2047) {
    throw new RangeError(
      `writePes: stitch delta ${rounded} exceeds the PEC limit of -2048..2047`
    );
  }
  return rounded;
}

function writeValue(out: ByteWriter, value: number, forceLong = false, flag = 0): void {
  if (!forceLong && value > -64 && value < 63) {
    out.writeUint8(value & 0x7f);
    return;
  }
  const encoded = (value & 0x0fff) | 0x8000 | (flag << 8);
  out.writeUint8((encoded >> 8) & 0xff);
  out.writeUint8(encoded & 0xff);
}

function writeDelta(out: ByteWriter, dx: number, dy: number, flag?: number): void {
  writeValue(out, dx, flag !== undefined, flag);
  writeValue(out, dy, flag !== undefined, flag);
}

function encodePecStitches(pattern: EmbPattern, out: ByteWriter): void {
  let colorTwo = true;
  let jumping = true;
  let initial = true;
  let x = 0;
  let y = 0;

  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    if (command === END) break;

    const dx = checkedDelta(stitch[0]! - x);
    const dy = checkedDelta(stitch[1]! - y);
    x += dx;
    y += dy;

    if (command === STITCH) {
      if (jumping) {
        if (dx !== 0 && dy !== 0) writeDelta(out, 0, 0);
        jumping = false;
      }
      writeDelta(out, dx, dy);
    } else if (command === JUMP) {
      jumping = true;
      writeDelta(out, dx, dy, initial ? JUMP_CODE : TRIM_CODE);
    } else if (command === COLOR_CHANGE) {
      if (jumping) {
        writeDelta(out, 0, 0);
        jumping = false;
      }
      out.writeBytes([0xfe, 0xb0, colorTwo ? 0x02 : 0x01]);
      colorTwo = !colorTwo;
    }
    initial = false;
  }
  out.writeUint8(0xff);
}

function writePecGraphics(pattern: EmbPattern, out: ByteWriter, extents: Extents): void {
  const allPoints: Stitch[] = [];
  for (const [block] of pattern.getAsStitchblock()) allPoints.push(...block);
  out.writeBytes(drawScaled(extents, allPoints, 4));

  for (const [block] of pattern.getAsColorblocks()) {
    const stitches = block.filter((stitch) => (stitch[2]! & COMMAND_MASK) === STITCH);
    out.writeBytes(drawScaled(extents, stitches, 5));
  }
}

function drawScaled(extents: Extents, points: Stitch[], buffer: number): Uint8Array {
  const graphic = BLANK_GRAPHIC.slice();
  const diagramWidth = extents.maxX - extents.minX || 1;
  const diagramHeight = extents.maxY - extents.minY || 1;
  const graphicWidth = PEC_STRIDE * 8;
  const graphicHeight = graphic.length / PEC_STRIDE;
  const scale = Math.min(
    (graphicWidth - buffer) / diagramWidth,
    (graphicHeight - buffer) / diagramHeight
  );
  const translateX = graphicWidth / 2 - ((extents.maxX + extents.minX) / 2) * scale;
  const translateY = graphicHeight / 2 - ((extents.maxY + extents.minY) / 2) * scale;

  for (const point of points) {
    const x = Math.floor(point[0]! * scale + translateX);
    const y = Math.floor(point[1]! * scale + translateY);
    if (x < 0 || x >= graphicWidth || y < 0 || y >= graphicHeight) continue;
    graphic[y * PEC_STRIDE + Math.floor(x / 8)]! |= 1 << x % 8;
  }
  return graphic;
}
