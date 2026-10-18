import { ByteReader, readInt8, readInt24le } from "../binary.js";
import { EmbPattern } from "../pattern.js";
import { EmbThread } from "../thread.js";
import { getThreadSet } from "../pecThreads.js";

const JUMP_CODE = 0x10;
const TRIM_CODE = 0x20;
const FLAG_LONG = 0x80;

function signed12(b: number): number {
  b &= 0xfff;
  if (b > 0x7ff) return -0x1000 + b;
  return b;
}

function signed7(b: number): number {
  if (b > 63) return -128 + b;
  return b;
}

export function readPec(f: ByteReader, out: EmbPattern, pesChart: EmbThread[] | null = null): void {
  f.seek(3, 1);
  const label = f.read(16);
  try {
    out.metadata("Label", new TextDecoder("utf-8", { fatal: true }).decode(label).trim());
  } catch {
    // Invalid UTF-8: no label.
  }
  f.seek(0xf, 1);
  const stride = readInt8(f)!, iconHeight = readInt8(f)!;
  f.seek(0xc, 1);
  const colorChanges = readInt8(f);
  if (colorChanges === null) {
    throw new Error("readPec: unexpected end of file in PEC header");
  }
  const countColors = colorChanges + 1;
  const colorBytes = f.read(countColors);
  mapPecColors(colorBytes, out, pesChart);
  f.seek(0x1d0 - colorChanges, 1);

  const lengthValue = readInt24le(f);
  if (lengthValue === null) {
    throw new Error("readPec: unexpected end of file reading stitch block length");
  }
  // The length is counted from 2 bytes before its own field.
  const stitchBlockEnd = lengthValue - 5 + f.tell();

  // 31 FF F0, width, height, 0x1E0, 0x1B0.
  f.seek(0x0b, 1);
  readPecStitches(f, out);
  f.seek(stitchBlockEnd, 0);
  f.read(stride * iconHeight * (countColors + 1));
}

function processPecColors(colorBytes: Uint8Array, out: EmbPattern): void {
  const threadSet = getThreadSet();
  const maxValue = threadSet.length;
  for (const byte of colorBytes) {
    const threadValue = threadSet[byte % maxValue]!;
    out.addThread(threadValue);
  }
}

function processPecTable(
  colorBytes: Uint8Array,
  out: EmbPattern,
  chart: EmbThread[]
): void {
  const threadSet = getThreadSet();
  const maxValue = threadSet.length;
  const threadMap = new Map<number, EmbThread>();
  for (let i = 0; i < colorBytes.length; i++) {
    const colorIndex = colorBytes[i]! % maxValue;
    let threadValue = threadMap.get(colorIndex) ?? null;
    if (threadValue === null) {
      if (chart.length > 0) threadValue = chart.shift()!;
      else threadValue = threadSet[colorIndex]!;
      threadMap.set(colorIndex, threadValue);
    }
    out.addThread(threadValue);
  }
}

function mapPecColors(
  colorBytes: Uint8Array,
  out: EmbPattern,
  chart: EmbThread[] | null
): void {
  if (chart === null || chart.length === 0) {
    processPecColors(colorBytes, out);
  } else if (chart.length >= colorBytes.length) {
    for (const thread of chart) {
      out.addThread(thread);
    }
  } else {
    processPecTable(colorBytes, out, chart);
  }
}

function readPecStitches(f: ByteReader, out: EmbPattern): void {
  for (;;) {
    const val1 = readInt8(f);
    const val2 = readInt8(f);
    if ((val1 === 0xff && val2 === 0x00) || val2 === null || val1 === null) {
      break;
    }
    if (val1 === 0xfe && val2 === 0xb0) {
      f.seek(1, 1);
      out.colorChange(0, 0);
      continue;
    }
    let jump = false;
    let trim = false;
    let x: number;
    let y: number;
    let code: number;
    let current2: number;

    if ((val1 & FLAG_LONG) !== 0) {
      if ((val1 & TRIM_CODE) !== 0) trim = true;
      if ((val1 & JUMP_CODE) !== 0) jump = true;
      code = (val1 << 8) | val2;
      x = signed12(code);
      const nextByte = readInt8(f);
      if (nextByte === null) break;
      current2 = nextByte;
    } else {
      x = signed7(val1);
      current2 = val2;
    }

    if ((current2 & FLAG_LONG) !== 0) {
      if ((current2 & TRIM_CODE) !== 0) trim = true;
      if ((current2 & JUMP_CODE) !== 0) jump = true;
      const val3 = readInt8(f);
      if (val3 === null) break;
      code = (current2 << 8) | val3;
      y = signed12(code);
    } else {
      y = signed7(current2);
    }

    if (jump) {
      out.move(x, y);
    } else if (trim) {
      out.trim();
      out.move(x, y);
    } else {
      out.stitch(x, y);
    }
  }
  out.end();
}
