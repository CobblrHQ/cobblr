import { z } from "zod";
import { EmbPattern } from "./embroidery-codecs/pattern.js";
import { EmbThread } from "./embroidery-codecs/thread.js";
import { EmbConstant as C } from "./embroidery-codecs/constants.js";
import { readPes } from "./embroidery-codecs/readers/pes.js";
import { readDst } from "./embroidery-codecs/readers/dst.js";
import { readExp } from "./embroidery-codecs/readers/exp.js";
import { readJef } from "./embroidery-codecs/readers/jef.js";
import { readVp3 } from "./embroidery-codecs/readers/vp3.js";
import { writePes } from "./embroidery-codecs/writePes.js";
import { writeDst } from "./embroidery-codecs/writeDst.js";
import { writeExp } from "./embroidery-codecs/writeExp.js";
import { writeJef } from "./embroidery-codecs/writeJef.js";
import { writeVp3 } from "./embroidery-codecs/writeVp3.js";
export const EmbroideryFormat = z.enum(["pes", "dst", "exp", "jef", "vp3"]);
export type EmbroideryFormat = z.infer<typeof EmbroideryFormat>;
export const HoopSchema = z.object({
  name: z.string().trim().min(1).max(100),
  width_mm: z.number().finite().positive().max(1000),
  height_mm: z.number().finite().positive().max(1000),
});
export const DesignSchema = z.object({
  version: z.literal(1),
  format: EmbroideryFormat,
  stitches: z
    .array(
      z.tuple([
        z.number().finite().min(-100000).max(100000),
        z.number().finite().min(-100000).max(100000),
        z.number().int().nonnegative().max(0x7fffffff),
      ]),
    )
    .min(1)
    .max(200000),
  threads: z
    .array(
      z.object({
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .nullable(),
        brand: z.string().max(200),
        code: z.string().max(200),
        name: z.string().max(200),
      }),
    )
    .max(1000),
});
export type EmbroideryDesign = z.infer<typeof DesignSchema>;
export interface ColourStop {
  index: number;
  thread_index: number;
  color: string | null;
  brand: string;
  code: string;
  name: string;
  stitches: number;
  estimated_m: number;
}
export interface EmbroiderySummary {
  width_mm: number;
  height_mm: number;
  x_mm: number;
  y_mm: number;
  stitch_count: number;
  colour_changes: number;
  estimated_minutes: number;
  stops: ColourStop[];
  paths: {
    color: string;
    points: [number, number][];
  }[];
}
const readers = {
  pes: readPes,
  dst: readDst,
  exp: readExp,
  jef: readJef,
  vp3: readVp3,
};
export function decodeEmbroidery(
  bytes: Uint8Array,
  format: EmbroideryFormat,
): EmbroideryDesign {
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024)
    throw new Error("Choose an embroidery file smaller than 2 MB.");
  if (
    format === "dst" &&
    (bytes.length < 515 ||
      Buffer.from(bytes.subarray(0, 3)).toString() !== "LA:")
  )
    throw new Error("This is not a complete DST file.");
  if (
    format === "pes" &&
    Buffer.from(bytes.subarray(0, 4)).toString() !== "#PES"
  )
    throw new Error("This is not a PES file.");
  if (
    format === "vp3" &&
    Buffer.from(bytes.subarray(0, 5)).toString() !== "%vsm%"
  )
    throw new Error("This is not a VP3 file.");
  if (
    format === "dst" &&
    !Array.from(
      { length: Math.floor((bytes.length - 512) / 3) },
      (_, i) => 512 + i * 3,
    ).some((i) => bytes[i + 2] === 0xf3)
  )
    throw new Error("Incomplete DST stitch block.");
  if (format === "jef") {
    if (bytes.length < 120) throw new Error("Incomplete JEF header.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset = view.getInt32(0, true),
      colours = view.getInt32(24, true);
    if (
      colours < 1 ||
      colours > 1000 ||
      offset < 116 + colours * 8 ||
      offset > bytes.length - 2 ||
      !Array.from(
        { length: Math.floor((bytes.length - offset) / 2) },
        (_, i) => offset + i * 2,
      ).some((i) => bytes[i] === 0x80 && bytes[i + 1] === 0x10)
    )
      throw new Error("Incomplete JEF stitch block.");
  }
  const pattern = readers[EmbroideryFormat.parse(format)](bytes);
  const design = DesignSchema.parse({
    version: 1,
    format,
    stitches: pattern.stitches,
    threads: pattern.threadlist.map((t) => ({
      color: t.hexColor(),
      brand: t.brand ?? "",
      code: t.catalog_number ?? "",
      name: t.description ?? "",
    })),
  });
  if (!design.stitches.some((s) => (s[2] & C.COMMAND_MASK) === C.STITCH))
    throw new Error("This file contains no stitches.");
  if (
    design.stitches.some(
      (s) =>
        (s[2] & C.COMMAND_MASK) === C.SEQUIN_MODE ||
        (s[2] & C.COMMAND_MASK) === C.SEQUIN_EJECT,
    )
  )
    throw new Error("Sequin designs need a machine-specific workflow.");
  return design;
}
export function summariseEmbroidery(
  raw: EmbroideryDesign,
  speed = 600,
): EmbroiderySummary {
  const design = DesignSchema.parse(raw);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 3000)
    throw new Error(
      "Set a positive stitch speed up to 3000 stitches per minute.",
    );
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    x = 0,
    y = 0,
    threadIndex = 0,
    stitchCount = 0;
  const stops: ColourStop[] = [],
    paths: EmbroiderySummary["paths"] = [];
  const newStop = () => {
    const t = design.threads[threadIndex];
    const stop: ColourStop = {
      index: stops.length,
      thread_index: threadIndex,
      color: t?.color ?? null,
      brand: t?.brand ?? "",
      code: t?.code ?? "",
      name: t?.name ?? "Unspecified colour",
      stitches: 0,
      estimated_m: 0,
    };
    stops.push(stop);
    return stop;
  };
  let stop = newStop(),
    path: EmbroiderySummary["paths"][number] | null = null;
  for (const [nextX, nextY, command] of design.stitches) {
    const c = command & C.COMMAND_MASK;
    if (c === C.END) break;
    minX = Math.min(minX, nextX);
    minY = Math.min(minY, nextY);
    maxX = Math.max(maxX, nextX);
    maxY = Math.max(maxY, nextY);
    if (c === C.COLOR_CHANGE || c === C.STOP) {
      if (c === C.COLOR_CHANGE) threadIndex++;
      stop = newStop();
      path = null;
    } else if (c === C.STITCH) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (!path) {
        path = { color: stop.color ?? "#666666", points: [[x / 10, y / 10]] };
        paths.push(path);
      }
      path.points.push([nextX / 10, nextY / 10]);
      stop.stitches++;
      stitchCount++;
      stop.estimated_m +=
        ((Math.hypot(nextX - x, nextY - y) / 10 + 0.5) * 1.15) / 1000;
    } else {
      path = null;
    }
    x = nextX;
    y = nextY;
  }
  const used = stops
    .filter((s) => s.stitches > 0)
    .map((s, index) => ({
      ...s,
      index,
      estimated_m: Math.ceil((s.estimated_m + 0.1) * 1000) / 1000,
    }));
  if (!Number.isFinite(minX) || !stitchCount)
    throw new Error("This design contains no usable stitches.");
  return {
    width_mm: (maxX - minX) / 10,
    height_mm: (maxY - minY) / 10,
    x_mm: minX / 10,
    y_mm: minY / 10,
    stitch_count: stitchCount,
    colour_changes: Math.max(0, used.length - 1),
    estimated_minutes:
      Math.ceil((stitchCount / speed + Math.max(0, used.length - 1)) * 10) / 10,
    stops: used,
    paths,
  };
}
export function hoopRefusal(
  design: {
    width_mm: number;
    height_mm: number;
  },
  hoop: {
    width_mm: number;
    height_mm: number;
  },
): string | null {
  if (
    ![design.width_mm, design.height_mm, hoop.width_mm, hoop.height_mm].every(
      Number.isFinite,
    ) ||
    hoop.width_mm <= 0 ||
    hoop.height_mm <= 0
  )
    return "Save the chosen hoop's usable dimensions.";
  return design.width_mm > hoop.width_mm + 0.000001 ||
    design.height_mm > hoop.height_mm + 0.000001
    ? "This design is larger than the chosen hoop. Choose a larger hoop or a smaller design."
    : null;
}
export function missingThreads(
  stops: {
    index: number;
  }[],
  mapping: Record<string, string>,
): number[] {
  return stops
    .filter((s) => !mapping[String(s.index)]?.trim())
    .map((s) => s.index);
}
export function encodeEmbroidery(
  raw: EmbroideryDesign,
  format: EmbroideryFormat,
  threadColours: Record<string, string> = {},
): Uint8Array {
  const design = DesignSchema.parse(raw),
    pattern = new EmbPattern();
  pattern.stitches = design.stitches.map((s) => [...s]);
  pattern.threadlist = design.threads.map((t) => {
    const thread = new EmbThread();
    thread.color = Number.parseInt((t.color ?? "#666666").slice(1), 16);
    thread.brand = t.brand;
    thread.catalog_number = t.code;
    thread.description = t.name;
    return thread;
  });
  const summary = summariseEmbroidery(design),
    palette = new Map<number, string>();
  const centerX = (summary.x_mm + summary.width_mm / 2) * 10,
    centerY = (summary.y_mm + summary.height_mm / 2) * 10;
  pattern.stitches = [
    [-centerX, -centerY, C.JUMP],
    ...design.stitches.map(([x, y, c]): [number, number, number] => [
      x - centerX,
      y - centerY,
      c,
    ]),
  ];
  if (format === "pes" && summary.stops.length > 255)
    throw new Error(
      "PES export supports at most 255 colour stops. Split this design.",
    );
  for (const stop of summary.stops) {
    const color = threadColours[String(stop.index)];
    if (
      color &&
      palette.has(stop.thread_index) &&
      palette.get(stop.thread_index) !== color.toLowerCase()
    )
      throw new Error(
        "Repeated stops for the same design colour need the same thread colour. Split the design to change them independently.",
      );
    if (color) palette.set(stop.thread_index, color.toLowerCase());
  }
  for (const stop of summary.stops) {
    const color = threadColours[String(stop.index)];
    if (!color) continue;
    if (!/^#[0-9a-f]{6}$/i.test(color))
      throw new Error("Choose a valid thread colour.");
    const t = pattern.threadlist[stop.thread_index] ?? new EmbThread();
    t.color = Number.parseInt(color.slice(1), 16);
    pattern.threadlist[stop.thread_index] = t;
  }
  const bytes =
    format === "dst"
      ? writeDst(pattern)
      : format === "pes"
        ? writePes(pattern)
        : format === "exp"
          ? writeExp(pattern)
          : format === "jef"
            ? writeJef(pattern, { date: "20260101000000" })
            : writeVp3(pattern);
  if (bytes.length > 2 * 1024 * 1024)
    throw new Error("The converted embroidery file is too large.");
  return bytes;
}
