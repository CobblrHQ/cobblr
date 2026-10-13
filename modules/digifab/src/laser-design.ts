import { SaxesParser } from "saxes";
import svgpath from "svgpath";
import type { Design, Point } from "./laser-layout.js";
const MAX_POINTS = 20000;
export function normalise(paths: Design["paths"]): Design {
 const all = paths.flatMap(p => p.points.flatMap(v => [v, ...(v.c0 ? [v.c0] : []), ...(v.c1 ? [v.c1] : [])]));
 if (!paths.length || all.length > MAX_POINTS || !all.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error("The drawing is empty, too large or has invalid coordinates.");
 const minX = Math.min(...all.map(p => p.x)), minY = Math.min(...all.map(p => p.y));
 const width = Math.max(...all.map(p => p.x)) - minX, height = Math.max(...all.map(p => p.y)) - minY;
 if (width <= 0 || height <= 0 || width > 100000 || height > 100000) throw new Error("The drawing must have a positive width and height in millimetres.");
 const shift = (p: Point): Point => ({ x: p.x - minX, y: p.y - minY });
 return { width, height, paths: paths.map(p => ({ ...p, points: p.points.map(v => ({ ...shift(v), ...(v.c0 ? { c0: shift(v.c0) } : {}), ...(v.c1 ? { c1: shift(v.c1) } : {}) })) })) };
}
function pathGeometry(data: string, layer: string, transform: string): Design["paths"] {
 // Arcs become cubics BEFORE the flip into machine coordinates: a cubic is
 // exact under any affine map, but svgpath's arc transform turns a mirrored
 // near-full arc into the short one, and a coaster's scored ring came out as
 // a dot (a-drawing-never-loses-geometry-on-the-way-to-a-laser.test.ts).
 const p = svgpath(data).abs().unshort().unarc().transform(transform);
 const error = (p as unknown as { err?: string }).err;
 if (error) throw new Error(`This drawing has an invalid path: ${error}`);
 const paths: Design["paths"] = [];
 let points: Point[] = [], curves: boolean[] = [];
 const flush = (closed: boolean) => { if (points.length > 1) paths.push({ layer, points, curves, closed }); points = []; curves = []; };
 p.iterate(s => {
  const command = s[0];
  if (command === "M") { flush(false); points.push({ x: s[1]!, y: s[2]! }); }
  else if (command === "Z") { curves.push(false); flush(true); }
  else {
   const a = points[points.length - 1]; if (!a) throw new Error("A path must start with a move.");
   if (command === "L") { curves.push(false); points.push({ x: s[1]!, y: s[2]! }); }
   else if (command === "H") { curves.push(false); points.push({ x: s[1]!, y: a.y }); }
   else if (command === "V") { curves.push(false); points.push({ x: a.x, y: s[1]! }); }
   else if (command === "C") { a.c1 = { x: s[1]!, y: s[2]! }; curves.push(true); points.push({ x: s[5]!, y: s[6]!, c0: { x: s[3]!, y: s[4]! } }); }
   else if (command === "Q") { a.c1 = { x: a.x + 2 / 3 * (s[1]! - a.x), y: a.y + 2 / 3 * (s[2]! - a.y) }; curves.push(true); points.push({ x: s[3]!, y: s[4]!, c0: { x: s[3]! + 2 / 3 * (s[1]! - s[3]!), y: s[4]! + 2 / 3 * (s[2]! - s[4]!) } }); }
   else throw new Error(`Unsupported path command ${command}. Convert it to plain paths first.`);
  }
  if (points.length > MAX_POINTS) throw new Error("This drawing has too many vertices.");
 });
 flush(false); return paths;
}
const length = (value: string | undefined): number | null => {
 if (value == null) return null;
 const m = /^([\d.]+)(mm|cm|in|pt|px)?$/.exec(value.trim()); if (!m) throw new Error("Use millimetres, inches or pixels for SVG dimensions.");
 const scale: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };
 return Number(m[1]) * scale[m[2] ?? "px"]!;
};
export function transformPaths(paths:Design["paths"], transform:string):Design["paths"] {
 const basis=pathGeometry("M0 0L1 0L0 1", "basis", transform)[0]!.points;
 const [origin,x,y]=basis as [Point,Point,Point];
 const tx=(p:Point):Point=>({x:origin.x+p.x*(x.x-origin.x)+p.y*(y.x-origin.x),y:origin.y+p.x*(x.y-origin.y)+p.y*(y.y-origin.y)});
 return paths.map(path=>({...path,points:path.points.map(p=>({...tx(p),...(p.c0?{c0:tx(p.c0)}:{}),...(p.c1?{c1:tx(p.c1)}:{})}))}));
}
export function parseSvg(text: string, onPath?: (paths: Design["paths"], id: string | undefined) => void, absolute = false, storedPart?: (id:string)=>Design["paths"]|undefined): Design {
 const paths: Design["paths"] = [];
 const stack: Array<{ transform: string; stroke: string; fill: string; ignore: boolean; id?: string }> = [];
 let root = false, scale = `scale(${25.4 / 96} ${-25.4 / 96})`;
 const parser = new SaxesParser({ xmlns: false });
 parser.on("doctype", () => { throw new Error("SVG document types and external entities are not supported."); });
 parser.on("opentag", tag => {
  const a = tag.attributes as Record<string, string>; const parent = stack[stack.length - 1];
  const style = Object.fromEntries((a.style ?? "").split(";").map(x => x.split(":").map(v => v.trim())).filter(x => x.length === 2));
  const name = tag.name.replace(/^.*:/, "");
  if (name === "svg") {
   if (root) throw new Error("Flatten nested SVG viewports before uploading."); root = true;
   const box = a.viewBox?.trim().split(/[\s,]+/).map(Number);
   if (box) {
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0) throw new Error("SVG viewBox is invalid.");
    const sx = (length(a.width) ?? box[2]! * 25.4 / 96) / box[2]!, sy = (length(a.height) ?? box[3]! * 25.4 / 96) / box[3]!;
    if (Math.abs(sx - sy) > 1e-6) throw new Error("Use the same horizontal and vertical SVG scale.");
    scale = `${absolute ? `translate(0 ${length(a.height) ?? box[3]! * sy}) ` : ""}scale(${sx} ${-sy}) translate(${-box[0]!} ${-box[1]!})`;
   }
  }
  const ownId=/^cobblr-(?:part-)?(\d+)$/.exec(a.id??"")?.[1]??a["data-part-id"];
  const ctx = { id: ownId ?? parent?.id, transform: `${parent?.transform ?? scale} ${a.transform ?? ""}`, stroke: a.stroke ?? style.stroke ?? parent?.stroke ?? "none", fill: a.fill ?? style.fill ?? parent?.fill ?? "black", ignore: parent?.ignore || ["defs", "metadata", "title", "desc"].includes(name) || style.display === "none" || a.display === "none" };
  stack.push(ctx);
  const stored=ownId&&!ctx.ignore?storedPart?.(ownId):undefined;
  if(stored){const geometry=transformPaths(stored,ctx.transform);paths.push(...geometry);onPath?.(geometry,ownId);ctx.ignore=true;return;}
  if (a["clip-path"] || a.mask || style["clip-path"] || a.filter || style.filter) throw new Error("Flatten masks, filters and clipping before uploading.");
  if (a["stroke-dasharray"] || style["stroke-dasharray"]) throw new Error("Convert dashed strokes to separate paths before uploading.");
  if (a.class || a["marker-start"] || a["marker-end"] || a["marker-mid"] || style["marker-start"] || style["marker-end"] || style["marker-mid"] || a["vector-effect"]) throw new Error("Flatten CSS classes, markers and vector effects before uploading.");
  if (name === "style" || a.opacity || style.opacity || a.visibility || style.visibility) throw new Error("Flatten styles, opacity and visibility before uploading.");
  if (ctx.ignore || ["svg", "g"].includes(name)) return;
  let d = a.d;
  const val = (k: string, fallback = 0) => a[k] == null ? fallback : Number(a[k]);
  if (name === "rect") { if (val("rx") || val("ry")) throw new Error("Convert rounded rectangles to paths first."); const x = val("x"), y = val("y"), w = val("width"), h = val("height"); d = `M${x} ${y}h${w}v${h}h${-w}z`; }
  else if (name === "line") d = `M${val("x1")} ${val("y1")}L${val("x2")} ${val("y2")}`;
  else if (name === "polygon" || name === "polyline") d = `M${a.points ?? ""}${name === "polygon" ? "z" : ""}`;
  else if (name === "circle" || name === "ellipse") { const x = val("cx"), y = val("cy"), rx = name === "circle" ? val("r") : val("rx"), ry = name === "circle" ? rx : val("ry"); d = `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`; }
  else if (name !== "path") throw new Error(`Unsupported SVG element ${name}. Convert text, images and referenced shapes to paths first.`);
  if (!d) throw new Error("A drawing path has no geometry.");
  const geometry = pathGeometry(d, a["data-layer"] ?? (ctx.stroke !== "none" ? ctx.stroke : ctx.fill), ctx.transform);
  paths.push(...geometry); onPath?.(geometry, ctx.id);
 });
 parser.on("closetag", () => { stack.pop(); });
 parser.write(text).close();
 if (!root) throw new Error("Upload an SVG drawing.");
 return normalise(paths);
}
export function parseDxf(text: string, unspecifiedUnit: "mm" | "in" = "mm"): Design {
 const lines = text.split(/\r?\n/); const pairs: Array<[number, string]> = [];
 for (let i = 0; i + 1 < lines.length; i += 2) { const code = Number(lines[i]!.trim()); if (!Number.isInteger(code)) throw new Error("Upload an ASCII DXF drawing."); pairs.push([code, lines[i + 1]!.trim()]); }
 const unitsAt = pairs.findIndex(([c, v]) => c === 9 && v === "$INSUNITS");
 const unit = unitsAt >= 0 ? Number(pairs[unitsAt + 1]?.[1]) : 0;
 const factors: Record<number, number> = { 0: unspecifiedUnit === "in" ? 25.4 : 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
 const scale = factors[unit]; if (!scale) throw new Error("This DXF unit is unsupported. Export in millimetres or inches.");
 const paths: Design["paths"] = []; let inside = false;
 for (let i = 0; i < pairs.length; i++) {
  if (pairs[i]?.[0] !== 0) continue;
  const kind = pairs[i]![1]; let j = i + 1; while (j < pairs.length && pairs[j]![0] !== 0) j++;
  const codes = pairs.slice(i + 1, j); const first = (c: number) => codes.find(x => x[0] === c)?.[1];
  const num = (c: number, fallback = 0) => Number(first(c) ?? fallback);
  if (kind === "SECTION") { inside = first(2) === "ENTITIES"; continue; }
  if (kind === "ENDSEC") { inside = false; continue; }
  if (!inside) continue;
  if (Math.abs(num(30)) > 1e-8 || Math.abs(num(31)) > 1e-8 || num(210) || num(220) || num(230, 1) !== 1) throw new Error("Flatten DXF geometry to the XY plane first.");
  const layer = first(8) ?? "0"; let d = "";
  if (kind === "LINE") d = `M${num(10)} ${num(20)}L${num(11)} ${num(21)}`;
  else if (kind === "LWPOLYLINE") {
   if (codes.some(([c, v]) => c === 42 && Number(v) !== 0)) throw new Error("Convert DXF bulges to arcs or paths first.");
   const xy: Array<[number, number]> = []; let x: number | null = null;
   for (const [c, v] of codes) { if (c === 10) x = Number(v); else if (c === 20 && x != null) { xy.push([x, Number(v)]); x = null; } }
   d = `M${xy.map(p => p.join(" ")).join("L")}${num(70) & 1 ? "z" : ""}`;
  } else if (kind === "CIRCLE" || kind === "ARC") {
   const cx = num(10), cy = num(20), r = num(40); if (r <= 0) throw new Error("A DXF circle needs a positive radius.");
   if (kind === "CIRCLE") d = `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0z`;
   else { const a = num(50) * Math.PI / 180, b = num(51) * Math.PI / 180; const sweep = (b - a + Math.PI * 2) % (Math.PI * 2); d = `M${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}A${r} ${r} 0 ${Number(sweep > Math.PI)} 1 ${cx + r * Math.cos(b)} ${cy + r * Math.sin(b)}`; }
  } else throw new Error(`Unsupported DXF entity ${kind}. Export LINE, LWPOLYLINE, ARC or CIRCLE geometry first.`);
  paths.push(...pathGeometry(d, layer, `scale(${scale})`));
  i = j - 1;
 }
 return normalise(paths);
}
export function parseDesign(filename: string, bytes: Uint8Array, unit?: "mm" | "in"): Design {
 if (bytes.length > 2 * 1024 * 1024) throw new Error("Basic nesting accepts drawings up to 2 MB.");
 const text = Buffer.from(bytes).toString("utf8");
 if (/\.svg$/i.test(filename)) return parseSvg(text);
 if (/\.dxf$/i.test(filename)) return parseDxf(text, unit);
 throw new Error("Choose an SVG or ASCII DXF drawing.");
}
