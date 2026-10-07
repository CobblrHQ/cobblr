/** Port of pyembroidery's ExpReader. */
import { signed8 } from "../binary.js";
import { EmbPattern } from "../pattern.js";

/** Parses a Melco .exp file. EXP stores no thread colors. */
export function readExp(bytes: Uint8Array): EmbPattern {
  const out = new EmbPattern();
  if (bytes.length % 2) throw new Error("Incomplete EXP stitch.");
  for (let offset = 0; offset + 2 <= bytes.length; offset += 2) {
    if (bytes[offset]! !== 0x80) {
      out.stitch(signed8(bytes[offset]!), -signed8(bytes[offset + 1]!));
      continue;
    }
    const control = bytes[offset + 1]!;
    offset += 2;
    if (offset + 2 > bytes.length) throw new Error("Incomplete EXP command.");
    const x = signed8(bytes[offset]!);
    const y = -signed8(bytes[offset + 1]!);
    if (control === 0x80) {
      out.trim();
    } else if (control === 0x02) {
      out.stitch(x, y);
    } else if (control === 0x04) {
      out.move(x, y);
    } else if (control === 0x01) {
      out.colorChange();
      if (x !== 0 || y !== 0) out.move(x, y);
    } else {
      throw new Error("Unsupported EXP command.");
    }
  }
  out.end();
  return out;
}
