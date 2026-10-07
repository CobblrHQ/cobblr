/** Port of pyembroidery's JefReader. */
import { signed8 } from "../binary.js";
import { getJefThreadSet } from "../jefThreads.js";
import { EmbPattern } from "../pattern.js";
import type { EmbThread } from "../thread.js";

const PALETTE_START = 0x74;

/** Parses a Janome .jef file. */
export function readJef(bytes: Uint8Array): EmbPattern {
  const out = new EmbPattern();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const int32 = (offset: number) => (offset + 4 <= bytes.length ? view.getInt32(offset, true) : 0);
  const stitchesStart = int32(0);
  const colorCount = int32(24);

  // Index 0 marks a stop rather than a thread.
  const jefThreads = getJefThreadSet();
  const threads: (EmbThread | null)[] = [];
  for (let i = 0; i < colorCount && PALETTE_START + 4 * i + 4 <= bytes.length; i++) {
    const index = Math.abs(int32(PALETTE_START + 4 * i));
    threads.push(index === 0 ? null : jefThreads[index % jefThreads.length]!);
  }

  let colorIndex = 1;
  for (let offset = stitchesStart; offset + 2 <= bytes.length; offset += 2) {
    if (bytes[offset]! !== 0x80) {
      out.stitch(signed8(bytes[offset]!), -signed8(bytes[offset + 1]!));
      continue;
    }
    const control = bytes[offset + 1]!;
    offset += 2;
    if (offset + 2 > bytes.length) break;
    if (control === 0x02) {
      out.move(signed8(bytes[offset]!), -signed8(bytes[offset + 1]!));
    } else if (control === 0x01) {
      if (threads[colorIndex]! === null) {
        out.stop();
        threads.splice(colorIndex, 1);
      } else {
        out.colorChange();
        colorIndex += 1;
      }
    } else {
      break;
    }
  }
  out.end();
  for (const thread of threads) if (thread !== null) out.addThread(thread);
  // Janome machines trim on jumps longer than 3 mm.
  out.interpolateTrims(null, 30, true);
  return out;
}
