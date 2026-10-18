/** Port of pyembroidery's Vp3Reader. */
import { ByteReader, readInt16be, readInt24be, readInt32be, readInt8, readSigned, readString8 } from "../binary.js";
import { EmbPattern } from "../pattern.js";
import { EmbThread } from "../thread.js";

const signed32 = (value: number | null) => (value ?? 0) | 0;
const signed16 = (high: number, low: number) => (((high & 0xff) << 8) | (low & 0xff)) << 16 >> 16;

function skipString(f: ByteReader): void {
  f.seek(readInt16be(f) ?? 0, 1);
}

function readString(f: ByteReader): string {
  return readString8(f, readInt16be(f) ?? 0) ?? "";
}

function readThread(f: ByteReader): EmbThread {
  const thread = new EmbThread();
  const colors = readInt8(f) ?? 0;
  readInt8(f); // Transition.
  for (let i = 0; i < colors; i++) {
    thread.color = readInt24be(f) ?? 0;
    readInt8(f); // Parts.
    readInt16be(f); // Length.
  }
  readInt8(f); // Thread type.
  readInt8(f); // Weight.
  thread.catalog_number = readString(f);
  thread.description = readString(f);
  thread.brand = readString(f);
  return thread;
}

function readColorblock(f: ByteReader, out: EmbPattern, centerX: number, centerY: number): void {
  f.seek(3, 1); // 00 05 00
  const blockEnd = (readInt32be(f) ?? 0) + f.tell();
  const startX = signed32(readInt32be(f)) / 100;
  const startY = -(signed32(readInt32be(f)) / 100);
  const [x, y] = [startX + centerX, startY + centerY];
  if (x !== 0 || y !== 0) out.moveAbs(x, y);
  out.addThread(readThread(f));
  f.seek(15, 1); // Block shift, then the stitch block's tag and length.
  f.seek(3, 1); // 0A F6 00
  const bytes = readSigned(f, blockEnd - f.tell());
  for (let i = 0; i < bytes.length - 1; ) {
    const [dx, dy] = [bytes[i]!, bytes[i + 1]!];
    i += 2;
    if ((dx & 0xff) !== 0x80) {
      out.stitch(dx, dy);
    } else if (dy === 0x01) {
      if (i + 4 > bytes.length) break;
      const longX = signed16(bytes[i]!, bytes[i + 1]!);
      const longY = signed16(bytes[i + 2]!, bytes[i + 3]!);
      // Then 80 02, skipped.
      i += 6;
      out.stitch(longX, longY);
    } else if (dy === 0x03) {
      out.trim();
    }
  }
}

/** Parses a Husqvarna Viking / Pfaff .vp3 file. */
export function readVp3(bytes: Uint8Array): EmbPattern {
  const out = new EmbPattern();
  const f = new ByteReader(bytes);
  f.seek(6); // %vsm%\0
  skipString(f); // Producer.
  f.seek(7, 1);
  skipString(f); // Notes and settings.
  f.seek(32, 1);
  const centerX = signed32(readInt32be(f)) / 100;
  const centerY = -(signed32(readInt32be(f)) / 100);
  f.seek(27, 1);
  skipString(f);
  f.seek(24, 1);
  skipString(f); // Producer.
  const colorCount = readInt16be(f) ?? 0;
  for (let i = 0; i < colorCount; i++) {
    readColorblock(f, out, centerX, centerY);
    if (i + 1 < colorCount) out.colorChange();
  }
  out.end();
  return out;
}
