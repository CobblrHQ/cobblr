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
  /** Estimated print seconds (slicer's "normal mode" estimate). */
  estimated_sec?: number;
  /** Filament/material type token: PLA, PETG, ABS, … */
  material?: string;
  layer_height_mm?: number;
  nozzle_mm?: number;
  /** Total filament grams for the plate, when the slicer states it. */
  filament_g?: number;
  /** How many discrete parts one plate yields (from the `Nx ` filename prefix). */
  parts_per_plate?: number;
  /** Which slicer wrote the file, when stated. */
  slicer?: string;
}

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
  if (mat) out.material = mat.split(";")[0]!.trim().toUpperCase();

  const layer = grab(/;\s*layer_height\s*=\s*([\d.]+)/i);
  if (layer && Number(layer) > 0) out.layer_height_mm = Number(layer);

  const nozzle = grab(/;\s*nozzle_diameter\s*=\s*([\d.]+)/i);
  if (nozzle && Number(nozzle) > 0) out.nozzle_mm = Number(nozzle);

  // Grams: Prusa `; total filament used [g] = 12.34` / `; filament used [g] = 12.34`.
  // Multi-tool prints list per-extruder (`= 12.3, 4.5`) — sum them.
  const gramsRaw = grab(/;\s*(?:total\s+)?filament used \[g\]\s*=\s*([\d.,\s]+)/i);
  if (gramsRaw) {
    const g = gramsRaw.split(/[,;]/).map((x) => parseFloat(x.trim())).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
    if (g > 0) out.filament_g = Math.round(g * 100) / 100;
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
  const re = /<filament\b[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const gm = /used_g\s*=\s*"([\d.]+)"/i.exec(m[0]); if (gm) g += parseFloat(gm[1]!);
    const tm = /type\s*=\s*"([^"]+)"/i.exec(m[0]); if (tm) types.push(tm[1]!.trim().toUpperCase());
  }
  if (g > 0) out.filament_g = Math.round(g * 100) / 100;
  if (types.length) out.material = types[0];
  const pred = /<metadata\s+key="prediction"\s+value="([\d.]+)"/i.exec(xml);
  if (pred && Number(pred[1]) > 0) out.estimated_sec = Math.round(Number(pred[1]));
  return out;
}

/** Extract everything we can. Comment headers win over filename tokens. */
export function extractPlateMetadata(filename: string, bytes: Buffer): PlateMetadata {
  const fromName = fromFilename(filename);
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
