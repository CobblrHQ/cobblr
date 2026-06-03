// Minimal 3MF parser — enough to PREVIEW the model, not to edit it. A .3mf is
// an OPC zip whose `3D/3dmodel.model` part is XML holding object meshes:
//   <object pid? pindex?><mesh><vertices><vertex x y z/>…</vertices>
//     <triangles><triangle v1 v2 v3 pid? p1?/>…</triangles></mesh></object>
// We unzip (fflate), pull every object's mesh into one merged geometry, and —
// when the file declares colours (<basematerials>/<colorgroup>) — paint each
// object its colour so multi-part 3MFs render in colour. Build-item transforms
// and per-triangle (vs per-object) colours are ignored — fine for a preview.
// fflate + the regex parse both run in node, so this is unit-testable.
import { unzipSync, strFromU8 } from "fflate";

export interface MeshGeom {
  positions: number[]; // flat [x,y,z, x,y,z, …]
  indices: number[]; // flat [v1,v2,v3, …]
  /** Optional per-vertex RGB (flat [r,g,b, …], 0..1). Set only when a format
   *  carries real, varied colours (a multi-colour STEP/IGES/3MF assembly);
   *  absent → the renderer uses the default material. */
  colors?: number[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  empty: boolean;
}

type RGB = [number, number, number];
const GREY: RGB = [0.7, 0.7, 0.7];

function attrNum(attrs: string, name: string): number {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? parseFloat(m[1]!) : NaN;
}
function attrStr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1]! : null;
}
function hexToRgb(hex: string | null): RGB | null {
  if (!hex) return null;
  const h = hex.replace(/^#/, "");
  if (h.length < 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r / 255, g / 255, b / 255];
}

/** Colour resource id → ordered RGB list. Covers <basematerials> (displaycolor)
 *  and the materials-extension <colorgroup> (<color color=…>), m:-prefixed or not. */
function parseColorResources(xml: string): Map<number, RGB[]> {
  const palette = new Map<number, RGB[]>();
  const collect = (groupRe: RegExp, itemRe: RegExp, attr: string) => {
    let g: RegExpExecArray | null;
    while ((g = groupRe.exec(xml))) {
      const id = parseInt(attrStr(g[1]!, "id") ?? "", 10);
      if (Number.isNaN(id)) continue;
      const colors: RGB[] = [];
      let it: RegExpExecArray | null;
      const re = new RegExp(itemRe.source, "g");
      while ((it = re.exec(g[2]!))) colors.push(hexToRgb(attrStr(it[1]!, attr)) ?? GREY);
      palette.set(id, colors);
    }
  };
  collect(/<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g, /<base\b([^>]*?)\/?>/, "displaycolor");
  collect(/<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g, /<(?:\w+:)?color\b([^>]*?)\/?>/, "color");
  return palette;
}

/** An object's colour: its own pid/pindex, else the colour its first coloured
 *  triangle references, else null (renderer falls back to the default material). */
function objectColor(objAttrs: string, body: string, palette: Map<number, RGB[]>): RGB | null {
  const pid = parseInt(attrStr(objAttrs, "pid") ?? "", 10);
  if (!Number.isNaN(pid) && palette.has(pid)) {
    const pindex = parseInt(attrStr(objAttrs, "pindex") ?? "0", 10) || 0;
    return palette.get(pid)![pindex] ?? null;
  }
  const t = body.match(/<triangle\b[^>]*?\bpid\s*=\s*"(\d+)"[^>]*?\bp1\s*=\s*"(\d+)"/);
  if (t) return palette.get(parseInt(t[1]!, 10))?.[parseInt(t[2]!, 10)] ?? null;
  return null;
}

export function parse3mfModelXml(xml: string): MeshGeom {
  const palette = parseColorResources(xml);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const distinct = new Set<string>();

  const addMesh = (block: string, color: RGB | null) => {
    const base = positions.length / 3;
    const c = color ?? GREY;
    let added = 0;
    const vRe = /<vertex\b([^>]*?)\/?>/g;
    let v: RegExpExecArray | null;
    while ((v = vRe.exec(block))) {
      const a = v[1]!;
      const x = attrNum(a, "x"), y = attrNum(a, "y"), z = attrNum(a, "z");
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
      positions.push(x, y, z);
      colors.push(c[0], c[1], c[2]);
      added++;
    }
    if (added > 0) distinct.add(`${c[0].toFixed(3)},${c[1].toFixed(3)},${c[2].toFixed(3)}`);
    const tRe = /<triangle\b([^>]*?)\/?>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(block))) {
      const a = t[1]!;
      const v1 = attrNum(a, "v1"), v2 = attrNum(a, "v2"), v3 = attrNum(a, "v3");
      if (Number.isNaN(v1) || Number.isNaN(v2) || Number.isNaN(v3)) continue;
      indices.push(base + v1, base + v2, base + v3);
    }
  };

  // Object-aware walk so each object can carry its own colour; fall back to a
  // bare mesh sweep (uncoloured) for files without <object> wrappers.
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let o: RegExpExecArray | null;
  let foundObj = false;
  while ((o = objRe.exec(xml))) {
    const body = o[2]!;
    const meshM = body.match(/<mesh\b[^>]*>([\s\S]*?)<\/mesh>/);
    if (!meshM) continue;
    foundObj = true;
    addMesh(meshM[1]!, objectColor(o[1]!, body, palette));
  }
  if (!foundObj) {
    const meshRe = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/g;
    let m: RegExpExecArray | null;
    while ((m = meshRe.exec(xml))) addMesh(m[1]!, null);
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const empty = positions.length === 0 || indices.length === 0;
  const out: MeshGeom = { positions, indices, bounds: { minX, minY, maxX, maxY, minZ, maxZ }, empty };
  // Only carry colours when the file is genuinely multi-colour (≥2 distinct);
  // a single-colour / uncoloured model stays on the default material.
  if (!empty && distinct.size >= 2) out.colors = colors;
  return out;
}

export function parse3mf(bytes: Uint8Array): MeshGeom {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  // The primary model part is 3D/3dmodel.model; fall back to any *.model.
  const key =
    names.find((n) => /(^|\/)3dmodel\.model$/i.test(n)) ??
    names.find((n) => /\.model$/i.test(n));
  if (!key) {
    return { positions: [], indices: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, minZ: 0, maxZ: 0 }, empty: true };
  }
  return parse3mfModelXml(strFromU8(files[key]!));
}
