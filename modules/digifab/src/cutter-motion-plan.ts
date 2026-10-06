import { CutterProfileSchema, cutterBounds, validateCutterProgram, type CutterProfile, type CutterProgram } from "@cobblr/platform-contract/cutter-program";
import { compileLaserPlan } from "./laser-motion-plan.js";
import type { Design, LayoutSheet, Point, Profile } from "./laser-layout.js";

function compensate(source: Point[], offset: number): Point[] {
  const points = source.filter((p, i) => !i || Math.hypot(p.x - source[i - 1]!.x, p.y - source[i - 1]!.y) > 0.000001);
  if (!offset || points.length < 2) return points;
  const direction = (a: Point, b: Point) => { const d = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; };
  const shifted = (p: Point, d: Point) => ({ x: p.x + offset * d.x, y: p.y + offset * d.y });
  const first = direction(points[0]!, points[1]!);
  const result = [shifted(points[0]!, first)];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!, from = direction(points[i - 1]!, p);
    result.push(shifted(p, from));
    const closed = Math.hypot(p.x - points[0]!.x, p.y - points[0]!.y) < 0.000001;
    const next = points[i + 1] ?? (closed ? points[1] : undefined);
    if (!next) continue;
    const to = direction(p, next), start = Math.atan2(from.y, from.x);
    const delta = Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y);
    const steps = Math.ceil(Math.abs(delta) / (Math.PI / 36));
    for (let step = 1; step <= steps; step++) { const angle = start + delta * step / steps; result.push({ x: p.x + offset * Math.cos(angle), y: p.y + offset * Math.sin(angle) }); }
    if (result.length > 200000) throw new Error("The blade compensation exceeds the motion point limit.");
  }
  return result;
}

export interface CutterOptions { mirror?: boolean; weed_box_mm?: number; weed_line_spacing_mm?: number }
export function compileCutterPlan(design: Design, sheet: LayoutSheet, asked: Record<string, CutterProfile>, bed: { width: number; height: number }, options: CutterOptions = {}): CutterProgram {
  const entries = Object.entries(asked).map(([layer, profile], index) => ({ ...CutterProfileSchema.parse(profile), layer, index }));
  if (entries.some(p => p.material_type === "htv") && entries.some(p => p.material_type !== "htv")) throw new Error("Keep heat transfer and other materials in separate jobs.");
  const mirrored = options.mirror ?? entries.some(p => p.material_type === "htv");
  const reflect = (p: Point): Point => ({ x: design.width - p.x, y: p.y });
  const drawing = mirrored ? { ...design, paths: design.paths.map(path => ({ ...path, points: path.points.map(p => ({ ...reflect(p), ...(p.c0 ? { c0: reflect(p.c0) } : {}), ...(p.c1 ? { c1: reflect(p.c1) } : {}) })) })) } : design;
  const profiles = Object.fromEntries(entries.map(p => [p.layer, { material: p.material, thickness_mm: 0.1, operation: "cut", speed: 1, min_power: 0, max_power: 0, passes: 1, air_assist: false, focus_offset: 0 } satisfies Profile]));
  const laser = compileLaserPlan(drawing, sheet, profiles, bed);
  const ordered = laser.layers.map(layer => ({ ...entries.find(p => p.layer === layer.layer)!, index: layer.index }));
  const paths: CutterProgram["paths"] = laser.paths.map(path => ({ ...path, purpose: "design", points: compensate(path.points, ordered.find(p => p.index === path.layer_index)!.blade_offset_mm) }));
  const weed = options.weed_box_mm ?? 0, spacing = options.weed_line_spacing_mm ?? 0;
  if (![weed, spacing].every(n => Number.isFinite(n) && n >= 0 && n <= 1000) || spacing > 0 && spacing < 0.1) throw new Error("Use a weed margin up to 1,000 mm and line spacing of at least 0.1 mm.");
  if (spacing && !weed) throw new Error("Add a weed box before weed lines.");
  if (weed) {
    const b = cutterBounds(paths), left = b.x - weed, right = b.x + b.width + weed, bottom = b.y - weed, top = b.y + b.height + weed;
    const layer_index = ordered[ordered.length - 1]!.index;
    const add = (points: Point[]) => paths.push({ layer_index, purpose: "weed", points: compensate(points, ordered[ordered.length - 1]!.blade_offset_mm) });
    add([{ x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }, { x: left, y: bottom }]);
    if (spacing) for (let y = bottom + spacing; y < top; y += spacing) {
      let intervals: Array<[number, number]> = [[left, right]];
      for (const part of sheet.parts) {
        const margin = Math.max(...ordered.map(p => p.blade_offset_mm)) + 0.1;
        if (y < part.y - margin || y > part.y + part.height + margin) continue;
        const a = part.x - margin, b = part.x + part.width + margin;
        intervals = intervals.flatMap(([lo, hi]) => b <= lo || a >= hi ? [[lo, hi] as [number, number]] : [...(a > lo ? [[lo, a] as [number, number]] : []), ...(b < hi ? [[b, hi] as [number, number]] : [])]);
      }
      for (const [a, b] of intervals) if (b - a > 0.05) add([{ x: a, y }, { x: b, y }]);
      if (paths.length > 200000) throw new Error("This weed spacing creates too many paths.");
    }
  }
  return validateCutterProgram({ version: 1, kind: "cutter", origin: "lower-left", width_mm: sheet.width, length_mm: sheet.height, bounds: cutterBounds(paths), profiles: ordered, paths, mirrored, mirror_label: mirrored ? entries.some(p => p.material_type === "htv") ? "Mirrored for heat transfer" : "Mirrored" : "Not mirrored" });
}
