/** Port of pyembroidery's ExpWriter. */
import { ByteWriter } from "./binaryWriter.js";
import { EmbConstant } from "./constants.js";
import type { EncoderSettings } from "./encoder.js";
import { EmbPattern } from "./pattern.js";
import { pyRound } from "./pyMath.js";

const { COMMAND_MASK, STITCH, JUMP, TRIM, STOP, COLOR_CHANGE } = EmbConstant;

/** The longest move one record can hold. */
const MAX_DELTA = 127;

export interface ExpWriteSettings extends EncoderSettings {
  /** Run the encoder first, splitting moves longer than EXP allows. Default true. */
  encode?: boolean;
}

function writeDelta(out: ByteWriter, dx: number, dy: number): void {
  if (Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) {
    throw new RangeError(`writeExp: a move exceeds the EXP limit of ${MAX_DELTA}`);
  }
  out.writeUint8(dx & 0xff);
  out.writeUint8(-dy & 0xff);
}

/** Serializes a pattern as a Melco .exp file. EXP stores no thread colors. */
export function writeExp(source: EmbPattern, settings: ExpWriteSettings = {}): Uint8Array {
  const { encode = true, ...encoderSettings } = settings;
  const pattern = encode
    ? source.getNormalizedPattern({
        max_jump: MAX_DELTA,
        max_stitch: MAX_DELTA,
        full_jump: true,
        // As in current pyembroidery: no trim before color changes.
        explicit_trim: false,
        round: true,
        sequin_contingency: EmbConstant.CONTINGENCY_SEQUIN_JUMP,
        ...encoderSettings,
      })
    : source;

  const out = new ByteWriter();
  let x = 0;
  let y = 0;
  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    const dx = pyRound(stitch[0]! - x);
    const dy = pyRound(stitch[1]! - y);
    x += dx;
    y += dy;
    if (command === STITCH) {
      writeDelta(out, dx, dy);
    } else if (command === JUMP) {
      out.writeBytes([0x80, 0x04]);
      writeDelta(out, dx, dy);
    } else if (command === TRIM) {
      out.writeBytes([0x80, 0x80, 0x07, 0x00]);
    } else if (command === COLOR_CHANGE || command === STOP) {
      out.writeBytes([0x80, 0x01, 0x00, 0x00]);
    }
  }
  return out.toUint8Array();
}
