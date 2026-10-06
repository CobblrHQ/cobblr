import { z } from "zod";

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const rectangle = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative() });
export const CutterProfileSchema = z.object({
  material: z.string().trim().min(1).max(120), material_type: z.enum(["vinyl", "htv", "cardstock", "custom"]),
  speed: z.number().finite().positive().max(100), force: z.number().int().min(1).max(1000),
  blade_depth: z.number().int().min(1).max(10), passes: z.number().int().min(1).max(20),
  blade_offset_mm: z.number().finite().min(0).max(2).default(0.25),
});
export type CutterProfile = z.infer<typeof CutterProfileSchema>;
export const CutterProgramSchema = z.object({
  version: z.literal(1), kind: z.literal("cutter"), origin: z.literal("lower-left"),
  width_mm: z.number().finite().positive().max(100000), length_mm: z.number().finite().positive().max(100000),
  bounds: rectangle, mirrored: z.boolean(), mirror_label: z.string().max(100),
  profiles: z.array(CutterProfileSchema.extend({ layer: z.string().min(1).max(120), index: z.number().int().nonnegative() })).min(1).max(30),
  paths: z.array(z.object({ layer_index: z.number().int().nonnegative(), purpose: z.enum(["design", "weed"]), points: z.array(point).min(2).max(200000) })).min(1).max(200000),
});
export type CutterProgram = z.infer<typeof CutterProgramSchema>;
export function cutterBounds(paths: CutterProgram["paths"]): CutterProgram["bounds"] {
  let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
  for (const path of paths) for (const p of path.points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); top = Math.max(top, p.y); }
  return { x, y, width: right - x, height: top - y };
}
export function validateCutterProgram(raw: unknown): CutterProgram {
  const program = CutterProgramSchema.parse(raw);
  const indices = new Set(program.profiles.map(p => p.index));
  if (indices.size !== program.profiles.length) throw new Error("Each cutter layer needs a unique profile.");
  let count = 0;
  for (const path of program.paths) {
    if (!indices.has(path.layer_index)) throw new Error("A cutter path has no material profile.");
    count += path.points.length;
    if (count > 200000) throw new Error("This cutter job has too many motion points.");
    for (const p of path.points) if (p.x < 0 || p.y < 0 || p.x > program.width_mm || p.y > program.length_mm) throw new Error("The compensated design is wider or longer than the loaded roll.");
  }
  const bounds = cutterBounds(program.paths);
  for (const key of ["x", "y", "width", "height"] as const) if (Math.abs(bounds[key] - program.bounds[key]) > 0.000001) throw new Error("The cutter job's bounds changed.");
  const label = program.mirrored ? program.profiles.some(p => p.material_type === "htv") ? "Mirrored for heat transfer" : "Mirrored" : "Not mirrored";
  if (program.mirror_label !== label) throw new Error("The mirror label does not match the cutter output.");
  return program;
}

export type CutterDialect = "hpgl" | "dmpl" | "silhouette";
export interface CutterController {
  dialect: CutterDialect; width_mm: number; length_mm: number;
  units_per_mm: number; max_speed: number; max_force: number;
  silhouette_generation?: "legacy" | "dual"; silhouette_tools?: 1 | 2; autoblade?: boolean;
}
export function cutterCommands(raw: CutterProgram, controller: CutterController, frame = false): string[] {
  const p = validateCutterProgram(raw);
  if (!["hpgl", "dmpl", "silhouette"].includes(controller.dialect)) throw new Error("Choose a supported cutter command language.");
  if (![controller.width_mm, controller.length_mm, controller.units_per_mm, controller.max_speed, controller.max_force].every(v => Number.isFinite(v) && v > 0)) throw new Error("Configure this cutter's range and command units first.");
  if (p.width_mm > controller.width_mm || p.length_mm > controller.length_mm) throw new Error("This design does not fit the saved cutter range.");
  if (p.profiles.some(s => s.speed > controller.max_speed || s.force > controller.max_force)) throw new Error("The material speed or force exceeds this cutter's configured range.");
  const coord = (v: number) => {
    const value = Math.round(v * controller.units_per_mm);
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new Error("The cutter coordinate exceeds its native range.");
    return value;
  };
  const xy = (v: { x: number; y: number }) => controller.dialect === "silhouette" ? `${coord(v.y)},${coord(v.x)}` : `${coord(v.x)},${coord(v.y)}`;
  const commands: string[] = [];
  const dual = controller.silhouette_generation === "dual";
  const suffix = dual ? ",1" : "";
  const selectTool = dual && controller.silhouette_tools !== 1;
  const totalCommands = p.profiles.reduce((sum, profile) => sum + p.paths.filter(path => path.layer_index === profile.index).reduce((n, path) => n + path.points.length + 1, 0) * profile.passes, 20 + p.profiles.length * 8);
  if (!frame && totalCommands > 500000) throw new Error("This cutter job exceeds the command limit.");
  const move = (v: { x: number; y: number }) => controller.dialect === "silhouette" ? `M${xy(v)}\x03` : controller.dialect === "dmpl" ? `U${xy(v)} ` : `PU${xy(v)};`;
  const cut = (v: { x: number; y: number }) => controller.dialect === "silhouette" ? `D${xy(v)}\x03` : controller.dialect === "dmpl" ? `D${xy(v)} ` : `PD${xy(v)};`;
  if (controller.dialect === "silhouette") commands.push("FN0\x03", "TB50,0\x03", "L0\x03", ...(selectTool ? ["J1\x03"] : []));
  else if (controller.dialect === "hpgl") commands.push("PA;", "PU;", "SP1;");
  else commands.push(";:A L0 ", "U ", "EC1 ");
  if (frame) {
    const b = p.bounds;
    const corners = [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }, { x: b.x, y: b.y }];
    commands.push(...corners.map(move));
  } else for (const profile of p.profiles) {
    if (controller.dialect === "silhouette") {
      if (!Number.isInteger(profile.speed)) throw new Error("Silhouette speed is a whole controller level.");
      commands.push(`!${profile.speed}${suffix}\x03`, `FX${profile.force}${suffix}\x03`, dual ? "FC0,0,1\x03" : "FC0\x03");
      if (controller.autoblade) { commands.push(`TF${profile.blade_depth},1\x03`); }
    } else if (controller.dialect === "hpgl") commands.push(`VS${profile.speed};`, `FS${profile.force};`);
    else commands.push(`V${profile.speed} `, `BP${profile.force} `);
    for (let pass = 0; pass < profile.passes; pass++) for (const path of p.paths.filter(path => path.layer_index === profile.index)) {
      commands.push(move(path.points[0]!));
      for (const point of path.points.slice(1)) commands.push(cut(point));
      commands.push(move(path.points[path.points.length - 1]!));
    }
  }
  if (controller.dialect === "silhouette") { if (selectTool) commands.push("J0\x03"); }
  else if (controller.dialect === "hpgl") commands.push("PU;", "SP0;");
  else commands.push("U ", "EC0 ");
  if (commands.length > 500000) throw new Error("This cutter job exceeds the command limit.");
  return commands;
}
