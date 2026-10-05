import { z } from "zod";
import { toCsv } from "@cobblr/platform-contract/csv";
import type { BoardFiles } from "./board-revision.js";
const finite = z.number().finite();
export const PackageCalibration = z.object({ package_id: z.string().trim().min(1).max(160), height_mm: finite.positive().max(50), top_zero_deg: finite, bottom_zero_deg: finite, rotation_sign: z.union([z.literal(1), z.literal(-1)]), offset_x_mm: finite, offset_y_mm: finite, nozzle: z.number().int().min(1).max(8), head: z.number().int().min(1).max(8), speed_pct: z.number().int().min(1).max(100), mode: z.number().int().min(1).max(4), verified_at: z.string().datetime() });
export const PlacementProfileSchema = z.object({ model: z.enum(["openpnp", "neoden4", "neoden-yy1", "neoden-k1830", "charmhigh-t48vb", "charmhigh-t36va"]), work_area_width_mm: finite.positive().max(5000), work_area_height_mm: finite.positive().max(5000), panel_origin_x_mm: finite.min(0), panel_origin_y_mm: finite.min(0), width_mm: finite.positive().max(2000), height_mm: finite.positive().max(2000), origin_x_mm: finite, origin_y_mm: finite, columns: z.number().int().min(1).max(100), gap_mm: finite.min(0).max(1000), packages: z.record(PackageCalibration) });
export type PlacementProfile = z.infer<typeof PlacementProfileSchema>;
export interface FeederAssignment { part_id: string; slot: string; mpn: string; manufacturer: string; placements: number; qty: number; lot_code?: string | null }
export interface ProgramPlacement { board: number; ref: string; part_id: string; slot: string; package: string; value: string; x_mm: number; y_mm: number; rotation: number; side: "top" | "bottom" }
export interface PlacementProgram { profile: PlacementProfile; feeders: FeederAssignment[]; placements: ProgramPlacement[]; files: Array<{ name: string; content: string }> }
const csvRows = (rows: Array<Array<string | number>>) => toCsv(rows[0]!.map(String), rows.slice(1), { bom: false });
const angle = (v: number) => ((v % 360) + 360) % 360;
const signed = (v: number) => v > 180 ? v - 360 : v;
const n = (v: number) => String(Math.round(v * 10000) / 10000);
const xml = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const location = (x: number, y: number, rotation = 0) => `<location units="Millimeters" x="${n(x)}" y="${n(y)}" z="0" rotation="${n(rotation)}"/>`;
export function verifyFeederScan(feeders: FeederAssignment[], slot: string, partId: string) {
  const expected = feeders.find(f => f.slot === slot);
  if (!expected) throw new Error("Choose a feeder slot from this job's map.");
  if (expected.part_id !== partId) throw new Error("Wrong reel for this feeder slot. Scan the reel in the job's feeder map.");
  return expected;
}
export function buildPlacementProgram(board: BoardFiles, boards: number, input: unknown, feeders: FeederAssignment[]): PlacementProgram {
  if (!Number.isInteger(boards) || boards < 1 || boards > 1000 || boards * board.placements.length > 200_000) throw new Error("This export is too large. Split it into work orders of at most 1000 boards and 200000 placements.");
  const parsed = PlacementProfileSchema.safeParse(input);
  if (!parsed.success) throw new Error("Fill the board dimensions and verified package calibration for this machine.");
  const profile = parsed.data;
  const panelWidth = profile.model === "openpnp" ? Math.min(boards, profile.columns) * (profile.width_mm + profile.gap_mm) - profile.gap_mm : profile.width_mm;
  const panelHeight = profile.model === "openpnp" ? Math.ceil(boards / profile.columns) * (profile.height_mm + profile.gap_mm) - profile.gap_mm : profile.height_mm;
  if (profile.panel_origin_x_mm + panelWidth > profile.work_area_width_mm || profile.panel_origin_y_mm + panelHeight > profile.work_area_height_mm) throw new Error("This board layout is outside the machine work area. Check panel columns, origin and spacing.");
  if (!feeders.length || new Set(feeders.map(f => f.slot)).size !== feeders.length || new Set(feeders.map(f => f.part_id)).size !== feeders.length) throw new Error("Each reel needs one distinct feeder slot.");
  if (feeders.some(f => !/^[A-Za-z0-9_.-]{1,80}$/.test(f.slot) || !Number.isInteger(f.placements) || f.placements < 1)) throw new Error("Fill every feeder slot and its whole placement count.");
  if (profile.model !== "openpnp" && feeders.some(f => !/^\d+$/.test(f.slot) || Number(f.slot) < 1 || Number(f.slot) > 200)) throw new Error("This machine needs numeric feeder slots from 1 to 200.");
  const remaining = new Map(feeders.map(f => [f.part_id, f.placements]));
  const refs = new Map(board.bom.flatMap(line => line.refs.map(ref => [ref, line] as const)));
  const placements: ProgramPlacement[] = [];
  for (let b = 1; b <= boards; b++) for (const p of board.placements) {
    const line = refs.get(p.ref);
    if (!line) throw new Error(`Placement ${p.ref} is absent from the BOM.`);
    const calibration = profile.packages[p.package];
    if (!calibration) throw new Error(`Package ${p.package} needs a verified rotation and offset calibration.`);
    const feeder = feeders.find(f => f.mpn === line.mpn && f.manufacturer === line.manufacturer && (remaining.get(f.part_id) ?? 0) > 0);
    if (!feeder) throw new Error(`The kit does not have enough placements for ${p.ref}.`);
    remaining.set(feeder.part_id, remaining.get(feeder.part_id)! - 1);
    const canonicalX = p.x_mm + profile.origin_x_mm, y = p.y_mm + profile.origin_y_mm;
    const x = profile.model !== "openpnp" && p.side === "bottom" ? profile.width_mm - canonicalX : canonicalX;
    const xCal = x + calibration.offset_x_mm, yCal = y + calibration.offset_y_mm;
    if (xCal < 0 || yCal < 0 || xCal > profile.width_mm || yCal > profile.height_mm) throw new Error(`Placement ${p.ref} is outside the PCB. Check dimensions, origin and calibration.`);
    placements.push({ board: b, ref: p.ref, part_id: feeder.part_id, slot: feeder.slot, package: p.package, value: line.value, x_mm: xCal, y_mm: yCal, rotation: angle(p.rotation * calibration.rotation_sign + (p.side === "top" ? calibration.top_zero_deg : calibration.bottom_zero_deg)), side: p.side });
  }
  if ([...remaining.values()].some(v => v !== 0)) throw new Error("The feeder map's placement counts do not match this work order.");
  const files: PlacementProgram["files"] = [];
  const sides = [...new Set(placements.map(p => p.side))];
  if (profile.model === "openpnp") {
    for (let b = 1; b <= boards; b++) {
      const entries = placements.filter(p => p.board === b).map(p => `    <placement version="1.4" id="${xml(p.ref)}" side="${p.side === "top" ? "Top" : "Bottom"}" part-id="reel-${xml(p.part_id)}" type="Placement" enabled="true">${location(p.x_mm, p.y_mm, p.rotation)}</placement>`);
      files.push({ name: `board-${b}.board.xml`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<openpnp-board name="Assembly board ${b}" version="1.1">\n  <dimensions units="Millimeters" x="${n(profile.width_mm)}" y="${n(profile.height_mm)}" z="0" rotation="0"/>\n  <placements>\n${entries.join("\n")}\n  </placements>\n</openpnp-board>\n` });
    }
    for (const side of sides) {
      const locations = Array.from({ length: boards }, (_, i) => `    <board-location side="${side === "top" ? "Top" : "Bottom"}" board-file="board-${i + 1}.board.xml" check-fiducials="false" enabled="true">${location(profile.panel_origin_x_mm + (i % profile.columns) * (profile.width_mm + profile.gap_mm), profile.panel_origin_y_mm + Math.floor(i / profile.columns) * (profile.height_mm + profile.gap_mm))}</board-location>`);
      files.push({ name: `${side}.job.xml`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<openpnp-job>\n  <board-locations>\n${locations.join("\n")}\n  </board-locations>\n</openpnp-job>\n` });
    }
    files.push({ name: "parts-and-feeders.csv", content: csvRows([["Part ID", "Package ID", "Height mm", "Reel ID", "Slot", "MPN", "Manufacturer", "Lot"], ...feeders.map(f => { const placement = placements.find(p => p.part_id === f.part_id)!; const c = profile.packages[placement.package]!; return [`reel-${f.part_id}`, c.package_id, c.height_mm, f.part_id, f.slot, f.mpn, f.manufacturer, f.lot_code ?? ""]; })]) });
  } else {
    for (let b = 1; b <= boards; b++) for (const side of sides) {
      const entries = placements.filter(p => p.board === b && p.side === side);
      if (!entries.length) continue;
      let rows: Array<Array<string | number>>;
      if (profile.model === "neoden-yy1") {
        rows = [["NEODEN", "YY1", "P&P FILE", ...Array(11).fill("")], Array(14).fill(""), ["PanelizedPCB", "UnitLength", 0, "UnitWidth", 0, "Rows", 1, "Columns", 1, ""], Array(14).fill(""), ["Fiducial", "1-X", 0, "1-Y", 0, "OverallOffsetX", "0.00", "OverallOffsetY", "0.00", ""], Array(14).fill(""), ...Array.from({ length: 4 }, (_, i) => ["NozzleChange", "OFF", "BeforeComponent", i + 1, "Head1", "Drop", "Station1", "PickUp", "Station1", ""]), Array(14).fill(""), ["Designator", "Comment", "Footprint", "Mid X(mm)", "Mid Y(mm)", "Rotation", "Head", "FeederNo", "Mount Speed(%)", "Pick Height(mm)", "Place Height(mm)", "Mode", "Skip"], ...entries.map(p => { const c = profile.packages[p.package]!; return [p.ref, p.value, c.package_id, p.x_mm.toFixed(2), p.y_mm.toFixed(2), Number(signed(p.rotation).toFixed(2)), c.head, p.slot, c.speed_pct, c.height_mm, c.height_mm, c.mode, 0]; })];
      } else {
        rows = [["Designator", "Footprint", "Mid X", "Mid Y", "Ref X", "Ref Y", "Pad X", "Pad Y", "Layer", "Rotation", "Comment"], ...entries.map(p => [p.ref, profile.packages[p.package]!.package_id, `${n(p.x_mm)}mm`, `${n(p.y_mm)}mm`, `${n(p.x_mm)}mm`, `${n(p.y_mm)}mm`, `${n(p.x_mm)}mm`, `${n(p.y_mm)}mm`, side === "top" ? "TopLayer" : "BottomLayer", signed(p.rotation), p.value])];
      }
      files.push({ name: `board-${b}-${side}.csv`, content: csvRows(rows) });
    }
    files.push({ name: "feeder-map.csv", content: csvRows([["Reel ID", "Slot", "MPN", "Manufacturer", "Lot", "Placements", "Reserved count"], ...feeders.map(f => [f.part_id, f.slot, f.mpn, f.manufacturer, f.lot_code ?? "", f.placements, f.qty])]) });
  }
  return { profile, feeders, placements, files };
}
