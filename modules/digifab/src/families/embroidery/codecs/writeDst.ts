/** Port of pyembroidery's DstWriter. */
import { ByteWriter } from "./binaryWriter.js";
import { EmbConstant } from "./constants.js";
import type { EncoderSettings } from "./encoder.js";
import { EmbPattern } from "./pattern.js";
import { pyRound } from "./pyMath.js";

const { COMMAND_MASK, STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE, SEQUIN_MODE, SEQUIN_EJECT } = EmbConstant;

const HEADER_SIZE = 512;
/** The longest move one record can hold: 81 + 27 + 9 + 3 + 1. */
const MAX_DELTA = 121;

export interface DstWriteSettings extends EncoderSettings {
  /** Run the encoder first, splitting moves longer than DST allows. Default true. */
  encode?: boolean;
  /** Also write author, copyright and thread colors in the header. Default false. */
  extendedHeader?: boolean;
}

// For weights 81, 27, 9, 3 and 1: [byte, bit for +weight, bit for -weight].
type AxisBits = [number, number, number][];
const WEIGHTS = [81, 27, 9, 3, 1] as const;
const X_BITS: AxisBits = [[2, 2, 3], [1, 2, 3], [0, 2, 3], [1, 0, 1], [0, 0, 1]];
const Y_BITS: AxisBits = [[2, 5, 4], [1, 5, 4], [0, 5, 4], [1, 7, 6], [0, 7, 6]];

/** Writes `value` into the record as balanced ternary. */
function encodeAxis(value: number, record: [number,number,number], bits: AxisBits): void {
  bits.forEach(([byte, positive, negative], i) => {
    const weight = WEIGHTS[i]!;
    if (value > (weight - 1) / 2) {
      record[byte]! = record[byte]! | 1 << positive;
      value -= weight;
    } else if (value < -(weight - 1) / 2) {
      record[byte]! = record[byte]! | 1 << negative;
      value += weight;
    }
  });
  if (value !== 0) throw new RangeError(`writeDst: a move exceeds the DST limit of ${MAX_DELTA}`);
}

function encodeRecord(dx: number, dy: number, command: number): number[] {
  const record: [number,number,number] = [0, 0, 0];
  if (command === STITCH || command === JUMP || command === SEQUIN_EJECT) {
    if (command !== STITCH) record[2]! |= 1 << 7;
    record[2]! |= 0b11;
    encodeAxis(dx, record, X_BITS);
    encodeAxis(-dy, record, Y_BITS);
  } else if (command === COLOR_CHANGE || command === STOP) {
    record[2]! = 0b11000011;
  } else if (command === END) {
    record[2]! = 0b11110011;
  } else if (command === SEQUIN_MODE) {
    record[2]! = 0b01000011;
  }
  return record;
}

function field(text: string): string {
  return `${text}\r`;
}

const signed = (value: number) => (value >= 0 ? `+${String(value).padStart(5)}` : `-${String(-value).padStart(5)}`);

function writeHeader(out: ByteWriter, pattern: EmbPattern, extended: boolean): void {
  const encoder = new TextEncoder();
  const stitches = pattern.stitches;
  const { minX, minY, maxX, maxY } =
    stitches.length > 0 ? pattern.extents() : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const last = stitches[stitches.length - 1]!;
  const name = pattern.getMetadata("name");
  const lines = [
    // Longer names would shift the fixed-width fields other programs expect.
    `LA:${(typeof name === "string" ? name : "Untitled").slice(0, 16).padEnd(16)}`,
    `ST:${String(pattern.countStitches()).padStart(7)}`,
    `CO:${String(pattern.countColorChanges()).padStart(3)}`,
    `+X:${String(Math.trunc(Math.abs(maxX))).padStart(5)}`,
    `-X:${String(Math.trunc(Math.abs(minX))).padStart(5)}`,
    `+Y:${String(Math.trunc(Math.abs(maxY))).padStart(5)}`,
    `-Y:${String(Math.trunc(Math.abs(minY))).padStart(5)}`,
    `AX:${signed(last ? Math.trunc(last[0]!) : 0)}`,
    `AY:${signed(last ? -Math.trunc(last[1]!) : 0)}`,
    `MX:${signed(0)}`,
    `MY:${signed(0)}`,
    "PD:******",
  ];
  if (extended) {
    const author = pattern.getMetadata("author");
    const copyright = pattern.getMetadata("copyright");
    if (author !== undefined) lines.push(`AU:${author}`);
    if (copyright !== undefined) lines.push(`CP:${copyright}`);
    for (const thread of pattern.threadlist) {
      lines.push(`TC:${thread.hexColor()},${thread.description ?? ""},${thread.catalog_number ?? ""}`);
    }
  }
  for (const line of lines) {
    const bytes = encoder.encode(field(line));
    // Keep room for the end-of-header byte; fields that don't fit are dropped.
    if (out.tell() + bytes.length >= HEADER_SIZE) break;
    out.writeBytes(bytes);
  }
  out.writeUint8(0x1a);
  out.writeBytes(new Array<number>(HEADER_SIZE - out.tell()).fill(0x20));
}

/** Serializes a pattern as a Tajima .dst file. DST keeps no thread colors unless `extendedHeader` is set. */
export function writeDst(source: EmbPattern, settings: DstWriteSettings = {}): Uint8Array {
  const { encode = true, extendedHeader = false, ...encoderSettings } = settings;
  const pattern = encode
    ? source.getNormalizedPattern({
        max_jump: MAX_DELTA,
        max_stitch: MAX_DELTA,
        full_jump: false,
        round: true,
        // As in current pyembroidery: the machine handles the thread change, no trim needed.
        explicit_trim: false,
        sequin_contingency: EmbConstant.CONTINGENCY_SEQUIN_UTILIZE,
        ...encoderSettings,
      })
    : source;

  const out = new ByteWriter();
  writeHeader(out, pattern, extendedHeader);
  let x = 0;
  let y = 0;
  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    const dx = pyRound(stitch[0]! - x);
    const dy = pyRound(stitch[1]! - y);
    x += dx;
    y += dy;
    if (command === TRIM) {
      // No trim command in DST: three jumps that end where they started.
      out.writeBytes(encodeRecord(2, 2, JUMP));
      out.writeBytes(encodeRecord(-4, -4, JUMP));
      out.writeBytes(encodeRecord(2, 2, JUMP));
    } else {
      out.writeBytes(encodeRecord(dx, dy, command));
    }
  }
  return out.toUint8Array();
}
