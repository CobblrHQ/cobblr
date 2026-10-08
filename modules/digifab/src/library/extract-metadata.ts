// Slicer metadata from an uploaded plate file — two tiers, best wins per field:
//
//   1. gcode COMMENT HEADERS (authoritative — the slicer wrote them):
//      PrusaSlicer / SuperSlicer / OrcaSlicer / Bambu Studio all emit
//      `; key = value` blocks (Prusa at the tail, Orca/Bambu at the head).
//   2. the FILENAME convention print-farm-manager standardized on
//      (`1x Bracket_0.4n_0.2mm_PLA_MK4S_5h11m.bgcode`) — the only tier that
//      can carry parts-per-plate, and the fallback when a .bgcode/.3mf hides
//      its comments (bgcode is binary; 3mf zips them).
//
// Pure function, no I/O — mirrors extract-thumbnail.ts: scan only the head +
// tail of the buffer so a 200 MB gcode never gets fully string-ified.

import { readZipEntry } from "./extract-thumbnail.js";

export interface PlateMetadata {
  /** Resin volume in ml, converted from the sliced file's cubic millimetres. */
  resin_ml?: number;
  layers?: number;
  /** Estimated LCD exposure, separate from lift and wait time. */
  exposure_sec?: number;
  /** Estimated print seconds (slicer's "normal mode" estimate). */
  estimated_sec?: number;
  /** Filament/material type token: PLA, PETG, ABS, … */
  material?: string;
  layer_height_mm?: number;
  nozzle_mm?: number;
  /** Total filament grams for the plate, when the slicer states it. */
  filament_g?: number;
  /** The same grams per filament the slicer used, tool 1 first (a
   *  multi-material plate draws on several spools; a slot that feeds none
   *  reads 0). Absent when the file states only a total. */
  filament_g_by_tool?: number[];
  material_by_tool?: string[];
  color_by_tool?: string[];
  /** How many discrete parts one plate yields (from the `Nx ` filename prefix). */
  parts_per_plate?: number;
  /** Which slicer wrote the file, when stated. */
  slicer?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const SCAN_BYTES = 512 * 1024; // comments live in the head/tail, like thumbnails

/** `5h 11m 20s`, `5h11m`, `47m 8s`, `132m` → seconds. */
function parseDuration(s: string): number | undefined {
  const h = /(\d+)\s*h/.exec(s);
  const m = /(\d+)\s*m/.exec(s);
  const sec = /(\d+)\s*s/.exec(s);
  if (!h && !m && !sec) return undefined;
  return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
}

const MATERIALS = /\b(PLA|PETG|ABS|ASA|TPU|PC|PA|NYLON|PVA|HIPS|PP|PCTG)\b/i;

/** Tier 1 — gcode comment headers. */
function fromComments(text: string): PlateMetadata {
  const out: PlateMetadata = {};
  const grab = (re: RegExp) => re.exec(text)?.[1]?.trim();

  // Time: Prusa `; estimated printing time (normal mode) = 5h 11m 20s`
  //       Orca/Bambu `; model printing time: 2h 30m 5s` / `; total estimated time: …`
  const time =
    grab(/;\s*estimated printing time[^=]*=\s*([^\r\n]+)/i) ??
    grab(/;\s*(?:model printing time|total estimated time):\s*([^\r\n;]+)/i);
  if (time) {
    const sec = parseDuration(time);
    if (sec) out.estimated_sec = sec;
  }

  // Material: `; filament_type = PLA` (Prusa/Orca; may be "PLA;PLA" multi-tool)
  const mat = grab(/;\s*filament_type\s*=\s*([^\r\n]+)/i);
  if (mat) {
    out.material_by_tool = mat.split(";").map(value => value.trim().toUpperCase());
    out.material = out.material_by_tool[0];
  }
  const colors = grab(/;\s*filament_colou?r\s*=\s*([^\r\n]+)/i);
  if (colors) out.color_by_tool = colors.split(";").map(value => value.trim());

  const layer = grab(/;\s*layer_height\s*=\s*([\d.]+)/i);
  if (layer && Number(layer) > 0) out.layer_height_mm = Number(layer);

  const nozzle = grab(/;\s*nozzle_diameter\s*=\s*([\d.]+)/i);
  if (nozzle && Number(nozzle) > 0) out.nozzle_mm = Number(nozzle);

  // Grams: Prusa `; total filament used [g] = 12.34` / `; filament used [g] = 12.34`.
  // Multi-tool prints list per-extruder (`= 12.3, 4.5`) — sum them.
  const gramsRaw = grab(/;\s*(?:total\s+)?filament used \[g\]\s*=\s*([\d.,\s]+)/i);
  if (gramsRaw) {
    const each = gramsRaw.split(/[,;]/).map((x) => parseFloat(x.trim())).map((n) => (Number.isFinite(n) ? n : 0));
    const g = each.reduce((a, b) => a + b, 0);
    if (g > 0) {
      out.filament_g = round2(g);
      out.filament_g_by_tool = each.map(round2);
    }
  }

  const slicer = grab(/;\s*generated (?:by|with)\s+([^\r\n]+)/i) ?? grab(/^;\s*(\S+Slicer[^\r\n]*)/im);
  if (slicer) out.slicer = slicer.split(" on ")[0]!.trim().slice(0, 80);

  return out;
}

/** Tier 2 — the PFM filename convention. Only source of parts_per_plate. */
export function fromFilename(filename: string): PlateMetadata {
  const out: PlateMetadata = {};
  const base = filename.replace(/\.(bgcode|gcode|3mf)$/i, "");

  const ppp = /^(\d+)\s*x[\s_-]/i.exec(base);
  if (ppp && Number(ppp[1]) >= 1) out.parts_per_plate = Number(ppp[1]);

  const mat = MATERIALS.exec(base);
  if (mat) out.material = mat[1]!.toUpperCase();

  const nozzle = /(\d+(?:\.\d+)?)n\b/i.exec(base);
  if (nozzle && Number(nozzle[1]) > 0 && Number(nozzle[1]) <= 2) out.nozzle_mm = Number(nozzle[1]);

  const layer = /(\d+(?:\.\d+)?)mm\b/i.exec(base);
  if (layer && Number(layer[1]) > 0 && Number(layer[1]) <= 1.5) out.layer_height_mm = Number(layer[1]);

  // Trailing `5h11m` / `47m` time token.
  const time = /(?:^|[_\s-])((?:\d+h)?\d+m)(?:$|[_\s-])/i.exec(base);
  if (time) {
    const sec = parseDuration(time[1]!);
    if (sec) out.estimated_sec = sec;
  }
  return out;
}

/** Tier 1b — a 3MF (Bambu/Orca) keeps its slice summary in a zip entry,
 *  Metadata/slice_info.config: one <filament .../> per extruder + a prediction. */
function from3mf(bytes: Buffer): PlateMetadata {
  const cfg = readZipEntry(bytes, (n) => /(?:^|\/)metadata\/slice_info\.config$/i.test(n));
  if (!cfg) return {};
  const xml = cfg.toString("utf8");
  const out: PlateMetadata = {};
  let g = 0;
  const types: string[] = [];
  const colors: string[] = [];
  // Each <filament> names its slot (id="1" is the first filament / AMS lane).
  const byTool: number[] = [];
  const re = /<filament\b[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const gm = /used_g\s*=\s*"([\d.]+)"/i.exec(m[0]);
    const used = gm ? parseFloat(gm[1]!) : 0;
    g += used;
    const id = Number(/\bid\s*=\s*"(\d+)"/i.exec(m[0])?.[1] ?? byTool.length + 1);
    if (id >= 1 && id <= 64) {
      while (byTool.length < id) byTool.push(0);
      byTool[id - 1] = round2((byTool[id - 1] ?? 0) + used);
    }
    if (id >= 1 && id <= 64) {
      types[id - 1] = /\btype\s*=\s*"([^"]+)"/i.exec(m[0])?.[1]?.trim().toUpperCase() ?? "";
      colors[id - 1] = /\bcolou?r\s*=\s*"([^"]+)"/i.exec(m[0])?.[1]?.trim() ?? "";
    }
  }
  if (g > 0) {
    out.filament_g = round2(g);
    out.filament_g_by_tool = byTool;
  }
  if (types.length) { out.material = types.find(Boolean); out.material_by_tool = Array.from(types, value => value ?? ""); }
  if (colors.some(Boolean)) out.color_by_tool = Array.from(colors, value => value ?? "");
  const pred = /<metadata\s+key="prediction"\s+value="([\d.]+)"/i.exec(xml);
  if (pred && Number(pred[1]) > 0) out.estimated_sec = Math.round(Number(pred[1]));
  return out;
}

/** Extract everything we can. Comment headers win over filename tokens. */
export function extractPlateMetadata(filename: string, bytes: Buffer): PlateMetadata {
  const fromName = fromFilename(filename);
  if (/\.goo$/i.test(filename)) return { ...fromName, ...fromGoo(bytes) };
  // .3mf is a zip (Bambu/Orca stash a slice_info.config); .bgcode is binary with
  // no readable comments — fall back to the filename convention for it.
  if (/\.3mf$/i.test(filename)) {
    const from3 = from3mf(bytes);
    return { ...fromName, ...from3, ...(fromName.parts_per_plate ? { parts_per_plate: fromName.parts_per_plate } : {}) };
  }
  if (!/\.gcode$/i.test(filename)) return fromName;
  const head = bytes.subarray(0, SCAN_BYTES).toString("latin1");
  const tail = bytes.byteLength > SCAN_BYTES ? bytes.subarray(bytes.byteLength - SCAN_BYTES).toString("latin1") : "";
  const fromHeader = fromComments(head + "\n" + tail);
  return { ...fromName, ...fromHeader, ...(fromName.parts_per_plate ? { parts_per_plate: fromName.parts_per_plate } : {}) };
}

/** Vendor GOO V1.2 header. Offsets follow the field widths in the published
 * specification: https://github.com/elegooofficial/GOO. No layer image decoding. */
function fromGoo(bytes: Buffer): PlateMetadata {
  if (bytes.length < 195477 || !bytes.subarray(4, 12).equals(Buffer.from([7, 0, 0, 0, 0x44, 0x4c, 0x50, 0]))) return {};
  const layers = bytes.readUInt32BE(195310);
  const bottom = bytes.readUInt32BE(195373);
  const seconds = bytes.readUInt32BE(195446);
  const volume = bytes.readFloatBE(195450);
  const normalExposure = bytes.readFloatBE(195336);
  const bottomExposure = bytes.readFloatBE(195369);
  const thickness = bytes.readFloatBE(195332);
  const exposure = Math.min(bottom, layers) * bottomExposure + Math.max(0, layers - bottom) * normalExposure;
  const profile = bytes.subarray(156, 188).toString("utf8").replace(/\0.*$/s, "").trim();
  const software = bytes.subarray(12, 44).toString("utf8").replace(/\0.*$/s, "").trim();
  return {
    ...(layers > 0 && layers <= 1000000 ? { layers } : {}),
    ...(seconds > 0 ? { estimated_sec: seconds } : {}),
    ...(Number.isFinite(volume) && volume > 0 ? { resin_ml: Math.round(volume * 1000000) / 1000000000 } : {}),
    ...(bytes[195445] === 0 && bytes.readUInt16BE(195475) === 0 && Number.isFinite(exposure) && exposure > 0 && normalExposure >= 0 && bottomExposure >= 0 ? { exposure_sec: exposure } : {}),
    ...(Number.isFinite(thickness) && thickness > 0 ? { layer_height_mm: thickness } : {}),
    ...(profile ? { material: profile } : {}),
    ...(software ? { slicer: software } : {}),
  };
}
