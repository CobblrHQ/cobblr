import { z } from "zod";
import { parseCsv, toCsv } from "@cobblr/platform-contract/csv";
import { placementConsumption } from "@cobblr/platform-contract/placement-count";

export const BoardImport = z.object({
  bom: z.string().min(1).max(2_000_000), positions: z.string().min(1).max(2_000_000),
  format: z.enum(["kicad", "altium", "eagle"]), units: z.enum(["mm", "in"]),
  bottom_x_mirrored: z.boolean(), mapping: z.record(z.string().max(160)).optional(),
});
export interface BoardBomLine { refs: string[]; mpn: string; manufacturer: string; value: string; package: string }
export interface BoardPlacement { ref: string; x_mm: number; y_mm: number; rotation: number; side: "top" | "bottom"; package: string }
export interface BoardFiles { bom: BoardBomLine[]; placements: BoardPlacement[]; source: z.infer<typeof BoardImport>["format"]; units: "mm" }
const aliases: Record<string, string[]> = {
  ref: ["Reference", "References", "Ref", "Designator", "Designators", "Part"], value: ["Value", "Val", "Comment"],
  package: ["Footprint", "Package", "Pattern"], mpn: ["MPN", "Manufacturer Part Number", "Part Number"],
  manufacturer: ["Manufacturer", "Maker"], x: ["PosX", "Center-X", "X"], y: ["PosY", "Center-Y", "Y"],
  rotation: ["Rot", "Rotation", "Angle"], side: ["Side", "Layer"], qty: ["Qty", "Quantity"], dnp: ["DNP", "Do Not Populate"],
};
const key = (v: string) => v.trim().toLowerCase();
function table(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);
  if (lines.some(l => /^#\s*Ref\s+Val\s+Package\s+/i.test(l))) {
    const header = lines.find(l => /^#\s*Ref\s+Val\s+Package\s+/i.test(l))!.replace(/^#\s*/, "");
    return [header, ...lines.filter(l => l.trim() && !l.startsWith("#"))].map(l => (l.match(/"(?:[^"]|"")*"|\S+/g) ?? []).map(c => c.replace(/^"|"$/g, "").replace(/""/g, '"')));
  }
  const header = lines[0] ?? "";
  const delimiter = header.includes(";") && !header.includes(",") ? ";" : header.includes("\t") && !header.includes(",") ? "\t" : ",";
  return parseCsv(clean, { delimiter, strict: true }).filter(r => r.some(c => c.trim()));
}
function reader(rows: string[][], mapping: Record<string, string>, label: string) {
  if (rows.length < 2 || rows.length > 20_001) throw new Error(`${label} needs a header and 1 to 20000 rows.`);
  const headers = rows[0]!.map(key);
  if (new Set(headers).size !== headers.length) throw new Error(`${label} has duplicate column headings.`);
  const indexes = new Map<string, number>();
  for (const [field, names] of Object.entries(aliases)) {
    const candidates = mapping[field] ? [mapping[field]!] : names;
    indexes.set(field, headers.findIndex(h => candidates.some(n => key(n) === h)));
  }
  return rows.slice(1).map((row, i) => {
    if (row.length !== headers.length) throw new Error(`${label} row ${i + 2} does not match its header. Check the separator and quoting.`);
    return (field: string, required = false) => {
      const index = indexes.get(field) ?? -1;
      const value = index < 0 ? "" : row[index]!.trim();
      if (required && !value) throw new Error(`${label} row ${i + 2}: map or fill ${field}.`);
      return value;
    };
  });
}
export function importBoardFiles(input: unknown): BoardFiles {
  const p = BoardImport.parse(input);
  if (p.format !== "kicad" && !p.mapping) throw new Error("Confirm the CSV column mapping for this export.");
  const mapping = p.mapping ?? {};
  const references = new Map<string, BoardBomLine>();
  const bom: BoardBomLine[] = [];
  for (const get of reader(table(p.bom), mapping, "BOM")) {
    if (/^(1|true|yes|dnp)$/i.test(get("dnp"))) continue;
    const refs = get("ref", true).split(/[,;\s]+/).filter(Boolean);
    if (refs.some(r => !/^[A-Za-z][A-Za-z0-9_]*\d+$/.test(r))) throw new Error("List each reference separately, such as R1, R2. Expand reference ranges first.");
    if (get("qty") && Number(get("qty")) !== refs.length) throw new Error(`BOM quantity disagrees with references ${refs.join(", ")}.`);
    const line = { refs, mpn: get("mpn", true), manufacturer: get("manufacturer"), value: get("value"), package: get("package", true) };
    for (const ref of refs) {
      if (references.has(ref)) throw new Error(`Duplicate BOM reference ${ref}.`);
      references.set(ref, line);
    }
    bom.push(line);
  }
  if (!bom.length) throw new Error("The BOM has no populated components.");
  const placements: BoardPlacement[] = [];
  const seen = new Set<string>();
  for (const get of reader(table(p.positions), mapping, "Positions")) {
    const ref = get("ref", true);
    if (seen.has(ref)) throw new Error(`Duplicate placement ${ref}.`);
    seen.add(ref);
    const line = references.get(ref);
    if (!line) throw new Error(`Placement ${ref} has no populated BOM reference. Remove DNP placements or include their BOM line.`);
    const numeric = ["x", "y", "rotation"].map(f => Number(get(f, true)));
    if (numeric.some(n => !Number.isFinite(n))) throw new Error(`Placement ${ref} needs numeric coordinates and rotation.`);
    const rawSide = key(get("side", true)).replace(/[ ._-]/g, "");
    const side = ["top", "front", "fcu", "toplayer"].includes(rawSide) ? "top" : ["bottom", "back", "bcu", "bottomlayer"].includes(rawSide) ? "bottom" : null;
    if (!side) throw new Error(`Placement ${ref}: choose top or bottom for the side.`);
    const footprint = get("package", true);
    if (footprint !== line.package) throw new Error(`Placement ${ref} has a different footprint from its BOM line.`);
    const factor = p.units === "in" ? 25.4 : 1;
    placements.push({ ref, x_mm: numeric[0]! * factor * (side === "bottom" && p.bottom_x_mirrored ? -1 : 1), y_mm: numeric[1]! * factor, rotation: ((numeric[2]! % 360) + 360) % 360, side, package: footprint });
  }
  for (const ref of references.keys()) if (!seen.has(ref)) throw new Error(`Missing placement for ${ref}.`);
  return { bom, placements, source: p.format, units: "mm" };
}

export interface BoardStock { id: string; mpn: string; manufacturer: string; qty: number; reserved: number; attrition_pct: number; usable: boolean; reason?: string; location?: string }
export function checkBoardStock(bom: readonly BoardBomLine[], boards: number, stock: readonly BoardStock[]) {
  if (!Number.isSafeInteger(boards) || boards < 1 || boards > 1_000_000) throw new Error("Choose a whole board quantity from 1 to 1000000.");
  const free = new Map(stock.map(s => [s.id, Math.max(0, Math.floor(s.qty - s.reserved))]));
  const lines = bom.map(line => {
    const matching = stock.filter(s => key(s.mpn) === key(line.mpn) && (!line.manufacturer || key(s.manufacturer) === key(line.manufacturer)));
    if (!line.manufacturer && new Set(matching.map(s => key(s.manufacturer))).size > 1) throw new Error(`Confirm the manufacturer for ${line.mpn}; more than one matches.`);
    const placements = line.refs.length * boards;
    let remaining = placements;
    const picks: Array<{ part_id: string; placements: number; consume: number; location?: string }> = [];
    for (const s of matching.filter(s => s.usable).sort((a, b) => a.attrition_pct - b.attrition_pct || a.id.localeCompare(b.id))) {
      let lo = 0, hi = remaining;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (placementConsumption(mid, s.attrition_pct) <= (free.get(s.id) ?? 0)) lo = mid;
        else hi = mid - 1;
      }
      if (lo > 0) {
        const consume = placementConsumption(lo, s.attrition_pct);
        picks.push({ part_id: s.id, placements: lo, consume, ...(s.location ? { location: s.location } : {}) });
        free.set(s.id, free.get(s.id)! - consume);
        remaining -= lo;
      }
      if (!remaining) break;
    }
    const attrition = Math.max(0, ...matching.map(s => s.attrition_pct));
    const short = placementConsumption(remaining, attrition);
    return { ...line, placements, on_hand: matching.reduce((n, s) => n + s.qty, 0), reserved: matching.reduce((n, s) => n + s.reserved, 0), short,
      required: picks.reduce((n, p) => n + p.consume, 0) + short, picks,
      msl_problems: matching.filter(s => !s.usable).map(s => ({ part_id: s.id, reason: s.reason ?? "Confirm storage history before use." })) };
  });
  return { boards, ready: lines.every(l => l.short === 0), lines };
}
export function distributorCart(distributor: "digikey" | "mouser" | "lcsc", lines: ReadonlyArray<{ mpn: string; manufacturer: string; short: number }>): string {
  const header = distributor === "lcsc" ? ["Manufacturer Part Number", "Quantity", "Manufacturer"] : ["Manufacturer Part Number", "Quantity", "Manufacturer"];
  const grouped = new Map<string, { mpn: string; manufacturer: string; qty: number }>();
  for (const l of lines.filter(l => l.short > 0)) {
    const k = `${key(l.mpn)}\u0000${key(l.manufacturer)}`;
    const old = grouped.get(k);
    grouped.set(k, { mpn: l.mpn, manufacturer: l.manufacturer, qty: (old?.qty ?? 0) + l.short });
  }
  return toCsv(header, [...grouped.values()].map(l => [l.mpn, l.qty, l.manufacturer]));
}
