import { z } from "zod";
export type Point = { x: number; y: number; c0?: Point; c1?: Point };
export type Design = { width: number; height: number; paths: { layer: string; points: Point[]; closed: boolean; curves?: boolean[] }[] };
export type Rect = { x: number; y: number; width: number; height: number };
/** A sheet to nest onto. `free_regions` is its usable leftover, each region
 *  [outline, ...holes] (inventory's sheet geometry); an older reading has only
 *  free_rectangles and used_outlines. */
export type Sheet = { id: string; width: number; height: number; revision: number; free_rectangles: Rect[]; free_regions?: Point[][][]; used_outlines?: Point[][]; outline?: Point[]; cut_capacity?: { shapes: number; vertices: number; sources: number } };
export type Placement = Rect & { rotated: boolean; number: number; footprint: Rect; angle?: number; translation?: Point; footprint_outline?: Point[] };
export type LayoutSheet = Sheet & { parts: Placement[]; remaining: Rect[]; nesting?: "outline" | "rectangle"; /** Why a part with an outline was nested by rectangle, said on the sheet. */ nesting_note?: string; nest_ms?: number; utilisation?: number };
export function canRecordCuts(capacity: Sheet["cut_capacity"], rectangles: Rect[], outlines?: Point[][]): boolean {
 const shapes = outlines?.length ?? rectangles.length;
 const vertices = outlines ? outlines.reduce((n,p)=>n+p.length,0) : shapes*4;
 return !capacity || shapes <= capacity.shapes && vertices <= capacity.vertices && Math.ceil(shapes/128) <= capacity.sources;
}
export const ProfileSchema = z.object({
 operation: z.enum(["cut", "score", "engrave"]), material: z.string().trim().min(1).max(120), thickness_mm: z.number().positive().max(1000),
 speed: z.number().positive().max(10000), min_power: z.number().min(0).max(100), max_power: z.number().min(0).max(100),
 passes: z.number().int().min(1).max(100), air_assist: z.boolean(), return_to_origin: z.boolean().optional(), focus_offset: z.number().min(-100).max(100),
}).refine(p => p.max_power >= p.min_power, "Maximum power must be at least minimum power.");
export type Profile = z.infer<typeof ProfileSchema>;
const contains = (a: Rect, b: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export function subtractRectangles(free: Rect[], used: Rect): Rect[] {
 const split = free.flatMap(r => {
  if (!overlap(r, used)) return [r];
  const a: Rect[] = [];
  if (used.x > r.x) a.push({ ...r, width: used.x - r.x });
  if (used.x + used.width < r.x + r.width) a.push({ ...r, x: used.x + used.width, width: r.x + r.width - used.x - used.width });
  if (used.y > r.y) a.push({ ...r, height: used.y - r.y });
  if (used.y + used.height < r.y + r.height) a.push({ ...r, y: used.y + used.height, height: r.y + r.height - used.y - used.height });
  return a;
 });
 return split.filter((r, i) => r.width > 0.000001 && r.height > 0.000001 && !split.some((s, j) => j !== i && contains(s, r) && (!contains(r, s) || j < i)));
}
export function nestParts(design: Pick<Design, "width" | "height">, quantity: number, sheets: Sheet[], spacing: number, kerf: number, rotate: boolean, partial = false): LayoutSheet[] {
 if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || ![design.width, design.height].every(n => Number.isFinite(n) && n > 0) || ![spacing, kerf].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) throw new Error("Give a positive part size, quantity up to 10,000 and valid spacing and kerf.");
 const margin = (spacing + kerf) / 2;
 const result: LayoutSheet[] = [];
 let next = 0;
 for (const s of sheets) {
  let free = s.free_rectangles.map(r => ({ ...r }));
  if (!free.every(r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 && contains({ x: 0, y: 0, width: s.width, height: s.height }, r))) throw new Error("The sheet's free rectangles are invalid.");
  const parts: Placement[] = [];
  while (next < quantity) {
   const choices = free.flatMap((r, i) => [false, ...(rotate ? [true] : [])].flatMap(rotated => {
    const width = rotated ? design.height : design.width, height = rotated ? design.width : design.height;
    const w = width + 2 * margin, h = height + 2 * margin;
    return w <= r.width + 1e-8 && h <= r.height + 1e-8 ? [{ i, rotated, width, height, score: Math.min(r.width - w, r.height - h), footprint: { x: r.x, y: r.y, width: w, height: h } }] : [];
   })).sort((a, b) => a.score - b.score || a.i - b.i || Number(a.rotated) - Number(b.rotated));
   const choice = choices[0]; if (!choice) break;
   parts.push({ x: choice.footprint.x + margin, y: choice.footprint.y + margin, width: choice.width, height: choice.height, footprint: choice.footprint, rotated: choice.rotated, number: ++next });
   free = subtractRectangles(free, choice.footprint);
   if (free.length > 4096) throw new Error("This sheet is too fragmented for basic nesting.");
  }
  if (parts.length) result.push({ ...s, parts, remaining: free });
  if (next === quantity) return result;
 }
 if (partial) return result;
 throw new Error(next ? `There is room for ${next} of ${quantity} parts. Add another sheet or reduce the quantity.` : "This part is bigger than every free area. Choose a larger sheet or reduce the part size.");
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const n = (v: number) => Number(v.toFixed(6));
export type LayerSettings = Profile & { index: number; layer: string };
export function orderedLaserLayers(design: Design, profiles: Record<string, Profile>): LayerSettings[] {
 const keys = [...new Set(design.paths.map(p => p.layer))];
 if (!keys.length || keys.length > 30 || keys.some(k => !profiles[k])) throw new Error("Map every design layer to a material profile first (up to 30 layers).");
 const order = { engrave: 0, score: 1, cut: 2 };
 const candidates = keys.map(layer => ({ ...ProfileSchema.parse(profiles[layer]), layer, index: 0 })).sort((a, b) => order[a.operation] - order[b.operation]);
 const bounds = (path: Design["paths"][number]): Rect => {
  const points = path.points.flatMap(p => [p, ...(p.c0 ? [p.c0] : []), ...(p.c1 ? [p.c1] : [])]);
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
 };
 const before = new Map(keys.map(k => [k, new Set<string>()]));
 for (const outer of design.paths.filter(p => p.closed && profiles[p.layer]!.operation === "cut")) for (const inner of design.paths.filter(p => p.closed && profiles[p.layer]!.operation === "cut" && p.layer !== outer.layer)) {
  const a = bounds(outer), b = bounds(inner);
  if (contains(a, b) && !contains(b, a)) before.get(outer.layer)!.add(inner.layer);
 }
 const layers: LayerSettings[] = [];
 while (candidates.length) {
  const index = candidates.findIndex(l => [...before.get(l.layer)!].every(k => layers.some(p => p.layer === k)));
  if (index < 0) throw new Error("These cut layers contain each other. Use one cutting profile for their inner and outer contours.");
  layers.push(candidates.splice(index, 1)[0]!);
 }
 layers.forEach((l, i) => { l.index = i; });
 return layers;
}
export function transformPlacedPoint(p: Point, part: Placement, height: number): Point {
 if (part.translation && part.angle != null) {
  const rad=part.angle*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad);
  return {x:part.translation.x+p.x*c-p.y*s,y:part.translation.y+p.x*s+p.y*c};
 }
 return {x:part.x+(part.rotated?height-p.y:p.x),y:part.y+(part.rotated?p.x:p.y)};
}
export function generateProject(design: Design, sheet: LayoutSheet, profiles: Record<string, Profile>): { xml: string; layers: LayerSettings[]; estimated_sec: number } {
 const layers = orderedLaserLayers(design, profiles);
 const settings = layers.map(l => `<CutSetting type="${l.operation === "engrave" ? "Scan" : "Cut"}">${Object.entries({ index: l.index, name: l.layer, speed: l.speed, minPower: l.min_power, maxPower: l.max_power, numPasses: l.passes, runBlower: Number(l.air_assist), zOffset: l.focus_offset, doOutput: 1, priority: l.index, interval: 0.1, enableLaser1: 1 }).map(([k, v]) => `<${k} Value="${esc(String(v))}"/>`).join("")}</CutSetting>`).join("");
 let estimated_sec = 0;
 const shapes = sheet.parts.flatMap(part => design.paths.map(path => {
  const l = layers.find(p => p.layer === path.layer)!;
  const transform = (p: Point): Point => transformPlacedPoint(p,part,design.height);
  const points = path.points.map(p => ({ ...transform(p), ...(p.c0 ? { c0: transform(p.c0) } : {}), ...(p.c1 ? { c1: transform(p.c1) } : {}) }));
  const verts = points.map(p => `V${n(p.x)} ${n(p.y)}${p.c0 ? `c0x${n(p.c0.x)}c0y${n(p.c0.y)}` : "c0x1"}${p.c1 ? `c1x${n(p.c1.x)}c1y${n(p.c1.y)}` : "c1x1"}`).join("");
  const count = points.length - (path.closed ? 0 : 1);
  const prims = Array.from({ length: count }, (_, i) => {
   const a = points[i]!, b = points[(i + 1) % points.length]!;
   const distance = path.curves?.[i] && a.c1 && b.c0 ? Math.hypot(a.c1.x-a.x,a.c1.y-a.y) + Math.hypot(b.c0.x-a.c1.x,b.c0.y-a.c1.y) + Math.hypot(b.x-b.c0.x,b.y-b.c0.y) : Math.hypot(b.x - a.x, b.y - a.y);
   estimated_sec += distance * l.passes / l.speed;
   return `${path.curves?.[i] ? "B" : "L"}${i} ${(i + 1) % points.length}`;
  }).join("");
  if (l.operation === "engrave") estimated_sec += design.width * design.height * l.passes / (0.1 * l.speed);
  return `<Shape Type="Path" CutIndex="${l.index}"><XForm>1 0 0 1 0 0</XForm><VertList>${verts}</VertList><PrimList>${prims}</PrimList></Shape>`;
 })).join("");
 return { xml: `<?xml version="1.0" encoding="UTF-8"?><LightBurnProject AppVersion="1.7.03" FormatVersion="1" MaterialHeight="0" MirrorX="False" MirrorY="False"><UIPrefs><Optimize_ByLayer Value="1"/><Optimize_InnerToOuter Value="1"/><Optimize_ByPriority Value="1"/></UIPrefs>${settings}${shapes}</LightBurnProject>`, layers, estimated_sec: Math.ceil(estimated_sec) };
}
type ProjectView = { transport?: string; project: Record<string, unknown>; layers?: Record<string, unknown>[]; cuts?: Record<string, unknown>[]; materialLibrary?: Record<string, unknown> };
function units(view: ProjectView) {
 const u = view.project.units as { distance?: string; speed?: string } | undefined;
 if (u?.distance !== "mm" || u.speed !== "mm/s") throw new Error("LightBurn must report millimetres and millimetres per second for these settings.");
}
export function verifyProject(expected: LayerSettings[], view: ProjectView): void {
 units(view);
 if (view.transport !== "rest") throw new Error("LightBurn REST is needed to verify a generated job.");
 const layers = view.layers?.filter(l => l.in_use === true) ?? [];
 const cuts = view.cuts?.filter(c => c.enabled !== false && layers.some(l => Number(l.index) === Number(c.layer_index ?? c.index))) ?? [];
 if (cuts.length !== expected.length || layers.length !== expected.length) throw new Error("LightBurn read back different layers or settings. The job was not queued.");
 for (const l of expected) {
  const cut = cuts.find(c => Number(c.layer_index ?? c.index) === l.index);
  const p = cut?.params as Record<string, unknown> | undefined;
  const values = { speed: l.speed, min_power: l.min_power, max_power: l.max_power, num_passes: l.passes, air_assist: l.air_assist, z_offset: l.focus_offset };
  if (!layers.some(x => Number(x.index) === l.index) || cut?.mode !== (l.operation === "engrave" ? "Fill" : "Line") || !p || Object.entries(values).some(([k, v]) => p[k] !== v)) throw new Error("LightBurn read back different profile settings. The job was not queued.");
 }
}
export function importProfiles(view: ProjectView): Array<Profile & { source: Record<string, unknown> }> {
 units(view);
 const library = view.materialLibrary ?? {};
 if (!Array.isArray(library.entries)) throw new Error("LightBurn did not report a loaded material library.");
 return library.entries.map(raw => {
  const e = raw as Record<string, unknown>; const c = e.cut as Record<string, unknown>; const p = c?.params as Record<string, unknown>;
  if (!c || !p || !["Line", "Fill"].includes(String(c.mode))) throw new Error("This library contains an unsupported operation. Use a Line or Fill material profile.");
  return { ...ProfileSchema.parse({ operation: c.mode === "Fill" ? "engrave" : "cut", material: e.material, thickness_mm: e.thickness, speed: p.speed, min_power: p.min_power, max_power: p.max_power, passes: p.num_passes, air_assist: p.air_assist, focus_offset: p.z_offset }), source: { library: library.name ?? null, guid: e.guid ?? null, imported_at: new Date().toISOString(), original: e } };
 });
}
export function generateNestedSvg(design: Design, sheet: LayoutSheet): string {
 const paths = design.paths.map(path=>{
  let d=`M${path.points[0]!.x} ${path.points[0]!.y}`;
  for(let i=0;i<path.points.length-(path.closed?0:1);i++) {
   const a=path.points[i]!,b=path.points[(i+1)%path.points.length]!;
   d+=path.curves?.[i]&&a.c1&&b.c0?`C${a.c1.x} ${a.c1.y} ${b.c0.x} ${b.c0.y} ${b.x} ${b.y}`:`L${b.x} ${b.y}`;
  }
  return `<path data-layer="${esc(path.layer)}" d="${d}${path.closed?"Z":""}"/>`;
 }).join("");
 const parts=sheet.parts.map(p=>`<g transform="${p.translation&&p.angle!=null?`translate(${p.translation.x} ${p.translation.y}) rotate(${p.angle})`:p.rotated?`translate(${p.x+design.height} ${p.y}) rotate(90)`:`translate(${p.x} ${p.y})`}">${paths}</g>`).join("");
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm" viewBox="0 0 ${sheet.width} ${sheet.height}"><g transform="translate(0 ${sheet.height}) scale(1 -1)" fill="none" stroke="black" stroke-width="0.1">${parts}</g></svg>`;
}

export function verifyLaserOutput(expected: LayerSettings[], view: ProjectView): void {
 if (view.transport !== "compiled") return verifyProject(expected, view);
 verifyProject(expected, { ...view, transport: "rest" });
}
