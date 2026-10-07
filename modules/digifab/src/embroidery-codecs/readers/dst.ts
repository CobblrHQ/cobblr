/** Port of pyembroidery's DstReader. */
import { EmbPattern } from "../pattern.js";

const bit = (value: number, position: number) => (value >> position) & 1;

/** Stitch records are balanced ternary: bits worth ±1, ±3, ±9, ±27 and ±81 per axis. */
function decodeDx(b0: number, b1: number, b2: number): number {
  return (
    81 * (bit(b2, 2) - bit(b2, 3)) +
    27 * (bit(b1, 2) - bit(b1, 3)) +
    9 * (bit(b0, 2) - bit(b0, 3)) +
    3 * (bit(b1, 0) - bit(b1, 1)) +
    (bit(b0, 0) - bit(b0, 1))
  );
}

/** DST's y axis points up. */
function decodeDy(b0: number, b1: number, b2: number): number {
  return -(
    81 * (bit(b2, 5) - bit(b2, 4)) +
    27 * (bit(b1, 5) - bit(b1, 4)) +
    9 * (bit(b0, 5) - bit(b0, 4)) +
    3 * (bit(b1, 7) - bit(b1, 6)) +
    (bit(b0, 7) - bit(b0, 6))
  );
}

function readHeader(header: Uint8Array, out: EmbPattern): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  header.forEach((byte, end) => {
    if (byte !== 13 && byte !== 10) return;
    let line: string;
    try {
      line = decoder.decode(header.subarray(start, end)).trim();
    } catch {
      return; // Non-UTF-8 field.
    } finally {
      start = end;
    }
    if (line.length <= 3) return;
    const [prefix, value] = [line.slice(0, 2).trim(), line.slice(3).trim()];
    if (prefix === "LA") out.metadata("name", value);
    else if (prefix === "AU") out.metadata("author", value);
    else if (prefix === "CP") out.metadata("copyright", value);
    else if (prefix === "TC") {
      const [hex, description, catalog] = value.split(",").map((part) => part.trim());
      out.addThread({ hex, description, catalog });
    } else out.metadata(prefix, value);
  });
}

/** Parses a Tajima .dst file. DST stores no thread colors unless the header lists them. */
export function readDst(bytes: Uint8Array): EmbPattern {
  const out = new EmbPattern();
  readHeader(bytes.subarray(0, 512), out);
  let sequinMode = false;
  for (let offset = 512; offset + 3 <= bytes.length; offset += 3) {
    const b0=bytes[offset]!, b1=bytes[offset+1]!, b2=bytes[offset+2]!;
    const dx = decodeDx(b0, b1, b2);
    const dy = decodeDy(b0, b1, b2);
    if ((b2 & 0b11110011) === 0b11110011) break;
    if ((b2 & 0b11000011) === 0b11000011) out.colorChange(dx, dy);
    else if ((b2 & 0b01000011) === 0b01000011) {
      out.sequinMode(dx, dy);
      sequinMode = !sequinMode;
    } else if ((b2 & 0b10000011) === 0b10000011) {
      if (sequinMode) out.sequinEject(dx, dy);
      else out.move(dx, dy);
    } else out.stitch(dx, dy);
  }
  out.end();
  // Trims are written as three jumps that cancel out.
  out.interpolateTrims(3);
  return out;
}
