/** Port of pyembroidery's JefWriter. */
import { ByteWriter } from "./binaryWriter.js";
import { EmbConstant } from "./constants.js";
import type { EncoderSettings } from "./encoder.js";
import { getJefThreadSet } from "./jefThreads.js";
import { EmbPattern } from "./pattern.js";
import { pyRound } from "./pyMath.js";
import type { EmbThread } from "./thread.js";

const { COMMAND_MASK, STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE } = EmbConstant;

const MAX_DELTA = 127;

const HOOP_110X110 = 0;
const HOOP_50X50 = 1;
const HOOP_140X200 = 2;
const HOOP_126X110 = 3;
const HOOP_200X200 = 4;

export interface JefWriteSettings extends EncoderSettings {
  /** Run the encoder first, splitting moves longer than JEF allows. Default true. */
  encode?: boolean;
  /** Write trims as commands. Default false: Janome machines trim on long jumps. */
  trims?: boolean;
  /** Commands written per trim when `trims` is set. Default 3. */
  trimAt?: number;
  /** Date in the header, as YYYYMMDDHHMMSS. Default now. */
  date?: string;
}

function sameThread(a: EmbThread | null, b: EmbThread): boolean {
  return (
    a !== null &&
    (a.color & 0xffffff) === (b.color & 0xffffff) &&
    a.description === b.description &&
    a.catalog_number === b.catalog_number &&
    a.details === b.details &&
    a.brand === b.brand &&
    a.chart === b.chart
  );
}

function now(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Janome thread indexes, one per color change or stop (stops alternate with index 0). */
function buildPalette(pattern: EmbPattern): number[] {
  const jefThreads = getJefThreadSet();
  const palette: number[] = [];
  let lastIndex: number | null = null;
  let lastThread: EmbThread | null = null;
  let colorToggled = false;
  let threadIndex = 0;
  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    if (command === COLOR_CHANGE || threadIndex === 0) {
      const thread = pattern.getThreadOrFiller(threadIndex);
      threadIndex += 1;
      let index = thread.findNearestColorIndex(jefThreads);
      // Neighbouring threads that map to the same Janome color get the next closest one.
      if (lastIndex === index && !sameThread(lastThread, thread)) {
        const repeatedIndex = index;
        const repeated = jefThreads[repeatedIndex]!;
        jefThreads[repeatedIndex] = null;
        index = thread.findNearestColorIndex(jefThreads);
        jefThreads[repeatedIndex] = repeated;
      }
      palette.push(index);
      lastIndex = index;
      lastThread = thread;
      colorToggled = false;
    }
    if (command === STOP) {
      colorToggled = !colorToggled;
      palette.push(colorToggled ? 0 : lastIndex!);
    }
  }
  return palette;
}

function hoopSize(width: number, height: number): number {
  if (width < 500 && height < 500) return HOOP_50X50;
  if (width < 1260 && height < 1100) return HOOP_126X110;
  if (width < 1400 && height < 2000) return HOOP_140X200;
  if (width < 2000 && height < 2000) return HOOP_200X200;
  return HOOP_110X110;
}

function writeHoopEdges(out: ByteWriter, x: number, y: number): void {
  const values = Math.min(x, y) >= 0 ? [x, y, x, y] : [-1, -1, -1, -1];
  for (const value of values) out.writeUint32le(value);
}

/** Serializes a pattern as a Janome .jef file. Thread colors become the nearest Janome threads. */
export function writeJef(source: EmbPattern, settings: JefWriteSettings = {}): Uint8Array {
  const { encode = true, trims = false, trimAt = 3, date = now(), ...encoderSettings } = settings;
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
  pattern.fixColorCount();

  const palette = buildPalette(pattern);
  const out = new ByteWriter();
  out.writeUint32le(0x74 + palette.length * 8);
  out.writeUint32le(0x14);
  out.writeBytes(new TextEncoder().encode(date));
  out.writeBytes([0, 0]);
  out.writeUint32le(palette.length);

  let pointCount = 1; // The END command.
  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    if (command === STITCH) pointCount += 1;
    else if (command === JUMP || command === COLOR_CHANGE || command === STOP) pointCount += 2;
    else if (command === TRIM && trims) pointCount += 2 * trimAt;
    else if (command === END) break;
  }
  out.writeUint32le(pointCount);

  const { minX, minY, maxX, maxY } =
    pattern.stitches.length > 0 ? pattern.extents() : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const width = pyRound(maxX - minX);
  const height = pyRound(maxY - minY);
  out.writeUint32le(hoopSize(width, height));
  const halfWidth = pyRound(width / 2);
  const halfHeight = pyRound(height / 2);
  // Distance from the hoop center, then from the edges of the 110×110, 50×50 and 140×200 hoops (twice).
  for (const value of [halfWidth, halfHeight, halfWidth, halfHeight]) out.writeUint32le(value);
  writeHoopEdges(out, 550 - halfWidth, 550 - halfHeight);
  writeHoopEdges(out, 250 - halfWidth, 250 - halfHeight);
  writeHoopEdges(out, 700 - halfWidth, 1000 - halfHeight);
  writeHoopEdges(out, 700 - halfWidth, 1000 - halfHeight);
  for (const index of palette) out.writeUint32le(index);
  for (let i = 0; i < palette.length; i++) out.writeUint32le(0x0d);

  const delta = (dx: number, dy: number) => {
    if (Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) {
      throw new RangeError(`writeJef: a move exceeds the JEF limit of ${MAX_DELTA}`);
    }
    out.writeBytes([dx & 0xff, -dy & 0xff]);
  };
  let x = 0;
  let y = 0;
  for (const stitch of pattern.stitches) {
    const command = stitch[2]! & COMMAND_MASK;
    const dx = pyRound(stitch[0]! - x);
    const dy = pyRound(stitch[1]! - y);
    x += dx;
    y += dy;
    if (command === STITCH) {
      delta(dx, dy);
    } else if (command === COLOR_CHANGE || command === STOP) {
      out.writeBytes([0x80, 0x01]);
      delta(dx, dy);
    } else if (command === TRIM) {
      if (trims) for (let i = 0; i < trimAt; i++) out.writeBytes([0x80, 0x02, 0x00, 0x00]);
    } else if (command === JUMP) {
      out.writeBytes([0x80, 0x02]);
      delta(dx, dy);
    } else if (command === END) {
      break;
    }
  }
  out.writeBytes([0x80, 0x10]);
  return out.toUint8Array();
}
