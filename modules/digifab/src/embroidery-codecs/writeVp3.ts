/** Port of pyembroidery's Vp3Writer. */
import { ByteWriter } from "./binaryWriter.js";
import { EmbConstant } from "./constants.js";
import type { EncoderSettings } from "./encoder.js";
import { EmbPattern, type Extents, type Stitch } from "./pattern.js";
import type { EmbThread } from "./thread.js";

const { COMMAND_MASK, FLAGS_MASK, STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE, SEQUIN_MODE, SEQUIN_EJECT } =
  EmbConstant;

const PRODUCER = "Produced by     Software Ltd";
/** Color changes split blocks; VP3 has no jumps: the next stitch moves there. */
const SKIPPED = new Set<number>([COLOR_CHANGE, SEQUIN_MODE, SEQUIN_EJECT, STOP, JUMP]);

export interface Vp3WriteSettings extends EncoderSettings {
  /** Run the encoder first, splitting moves longer than VP3 allows. Default true. */
  encode?: boolean;
}

function writeString8(out: ByteWriter, text: string): void {
  const bytes = new TextEncoder().encode(text);
  out.writeUint16be(bytes.length);
  out.writeBytes(bytes);
}

function writeString16(out: ByteWriter, text: string): void {
  out.writeUint16be(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUint16be(text.charCodeAt(i));
}

/** Starts a block whose length (from after the length field to its end) is filled in by the returned function. */
function block(out: ByteWriter, tag: number[]): () => void {
  out.writeBytes(tag);
  const offset = out.tell();
  out.writeUint32be(0);
  return () => {
    const end = out.tell();
    out.seek(offset);
    out.writeUint32be(end - offset - 4);
    out.seek(end);
  };
}

/** VP3 positions are in 1/1000 mm with y up, truncated to whole 0.1 mm first. */
const vp3 = (value: number) => Math.trunc(value) * 100;

function writeThread(out: ByteWriter, thread: EmbThread): void {
  out.writeBytes([0x01, 0x00]); // One color, no transition.
  out.writeUint24be(thread.color);
  out.writeBytes([0x00, 0x00, 0x00, 0x05, 0x28]); // No parts, no length, rayon 40 weight.
  writeString8(out, thread.catalog_number ?? "");
  writeString8(out, thread.description ?? thread.hexColor());
  writeString8(out, thread.brand ?? "");
}

function writeStitches(out: ByteWriter, stitches: Stitch[], firstX: number, firstY: number): void {
  const close = block(out, [0x00, 0x01, 0x00]);
  out.writeBytes([0x0a, 0xf6, 0x00]);
  let x = firstX;
  let y = firstY;
  for (const stitch of stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    if (command === END) {
      // The machine doesn't trim on its own at the end.
      out.writeBytes([0x80, 0x03]);
      break;
    }
    if (command === TRIM) {
      out.writeBytes([0x80, 0x03]);
      continue;
    }
    if (SKIPPED.has(command)) continue;
    const dx = Math.trunc(stitch[0]! - x);
    const dy = Math.trunc(stitch[1]! - y);
    x += dx;
    y += dy;
    if (command !== STITCH) continue;
    if (Math.abs(dx) <= 127 && Math.abs(dy) <= 127 && (stitch[2]! & FLAGS_MASK) === 0) {
      out.writeBytes([dx & 0xff, dy & 0xff]);
    } else {
      out.writeBytes([0x80, 0x01]);
      out.writeUint16be(dx);
      out.writeUint16be(dy);
      out.writeBytes([0x80, 0x02]);
    }
  }
  close();
}

function writeColorblock(
  out: ByteWriter,
  first: boolean,
  centerX: number,
  centerY: number,
  stitches: Stitch[],
  thread: EmbThread
): void {
  const close = block(out, [0x00, 0x05, 0x00]);
  let [firstX, firstY] = stitches.length > 0 ? [stitches[0]![0]!, stitches[0]![1]!] : [0, 0];
  if (first) [firstX, firstY] = [0, 0];
  const [lastX, lastY] = stitches.length > 0 ? [stitches[stitches.length - 1]![0]!, stitches[stitches.length - 1]![1]!] : [0, 0];
  out.writeUint32be(vp3(firstX - centerX));
  out.writeUint32be(vp3(-(firstY - centerY)));
  writeThread(out, thread);
  out.writeUint32be(vp3(lastX - firstX));
  out.writeUint32be(vp3(-(lastY - firstY)));
  writeStitches(out, stitches, firstX, firstY);
  out.writeUint8(0);
  close();
}

function writeDesign(out: ByteWriter, extents: Extents, colorblocks: [Stitch[], EmbThread][]): void {
  const close = block(out, [0x00, 0x03, 0x00]);
  const width = extents.maxX - extents.minX;
  const height = extents.maxY - extents.minY;
  const centerX = extents.maxX - width / 2;
  const centerY = extents.maxY - height / 2;
  out.writeUint32be(vp3(centerX));
  out.writeUint32be(-vp3(centerY));
  out.writeBytes([0, 0, 0]);
  for (const value of [-vp3(width / 2), vp3(width / 2), -vp3(height / 2), vp3(height / 2), vp3(width), vp3(height)]) {
    out.writeUint32be(value);
  }
  writeString16(out, ""); // Notes and settings.
  out.writeBytes([0x64, 0x64]);
  for (const value of [4096, 0, 0, 4096]) out.writeUint32be(value);
  out.writeBytes(new TextEncoder().encode("xxPP\x01\x00"));
  writeString16(out, PRODUCER);
  out.writeUint16be(colorblocks.length);
  colorblocks.forEach(([stitches, thread], i) => writeColorblock(out, i === 0, centerX, centerY, stitches, thread));
  close();
}

/** Serializes a pattern as a Husqvarna Viking / Pfaff .vp3 file. */
export function writeVp3(source: EmbPattern, settings: Vp3WriteSettings = {}): Uint8Array {
  const { encode = true, ...encoderSettings } = settings;
  const pattern = encode
    ? source.getNormalizedPattern({
        // VP3 stitches hold 16-bit moves; longer than 255 they count as jumps.
        max_jump: 3200,
        max_stitch: 255,
        full_jump: false,
        // As in current pyembroidery: no trim before color changes.
        explicit_trim: false,
        sequin_contingency: EmbConstant.CONTINGENCY_SEQUIN_JUMP,
        ...encoderSettings,
      })
    : source;
  pattern.fixColorCount();

  const out = new ByteWriter();
  out.writeBytes(new TextEncoder().encode("%vsm%"));
  out.writeUint8(0);
  writeString16(out, PRODUCER);
  const close = block(out, [0x00, 0x02, 0x00]);
  writeString16(out, ""); // Notes and settings.
  const extents: Extents =
    pattern.stitches.length > 0 ? pattern.extents() : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const colorblocks = [...pattern.getAsColorblocks()];
  for (const value of [extents.maxX, -extents.minY, extents.minX, -extents.maxY]) {
    out.writeUint32be(Math.trunc(value * 100));
  }
  out.writeUint32be(pattern.stitches.length - pattern.countStitchCommands(END));
  out.writeBytes([0, colorblocks.length & 0xff, 12, 0]);
  out.writeUint8(1); // One design.
  writeDesign(out, extents, colorblocks);
  close();
  return out.toUint8Array();
}
