/// <reference path="../../occt-import-js.d.ts" />
// STEP / IGES (.step/.stp/.iges/.igs) → mesh, via occt-import-js (OpenCASCADE
// compiled to WASM). Both are B-rep CAD, so the kernel must TESSELLATE them to
// triangles; this module merges occt's per-solid meshes into one
// BufferGeometry-ready {positions, indices, colors?}.
//
// `meshesToGeom` is pure (no WASM) so it's unit-testable; `readOcct` does the
// IO (the caller supplies an initialized occt module — node auto-locates the
// wasm, the browser passes locateFile → the Vite asset URL).
import type { OcctModule, OcctResult } from "occt-import-js";
import type { MeshGeom } from "./threemf-parse.js";

const EMPTY: MeshGeom = {
  positions: [],
  indices: [],
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, minZ: 0, maxZ: 0 },
  empty: true,
};

export function meshesToGeom(result: OcctResult): MeshGeom {
  if (!result?.success || !Array.isArray(result.meshes)) return EMPTY;
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const distinctColors = new Set<string>();
  for (const mesh of result.meshes) {
    const pos = mesh.attributes?.position?.array;
    const idx = mesh.index?.array;
    if (!pos || !idx) continue;
    const base = positions.length / 3; // offset this solid's indices
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]!);
    for (let i = 0; i < idx.length; i++) indices.push(base + idx[i]!);
    // occt gives one RGB (0..1) per solid; paint every vertex of this solid.
    const c = mesh.color && mesh.color.length >= 3 ? mesh.color : [0.7, 0.7, 0.7];
    distinctColors.add(`${c[0]!.toFixed(3)},${c[1]!.toFixed(3)},${c[2]!.toFixed(3)}`);
    const vCount = pos.length / 3;
    for (let i = 0; i < vCount; i++) colors.push(c[0]!, c[1]!, c[2]!);
  }
  if (positions.length === 0 || indices.length === 0) return EMPTY;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const out: MeshGeom = { positions, indices, bounds: { minX, minY, maxX, maxY, minZ, maxZ }, empty: false };
  // Only carry colours when the file is genuinely multi-colour (an assembly);
  // a single-colour part stays on the nicer default material.
  if (distinctColors.size >= 2) out.colors = colors;
  return out;
}

export type OcctKind = "step" | "iges";

export function readOcct(occt: OcctModule, bytes: Uint8Array, kind: OcctKind): MeshGeom {
  const result = kind === "iges" ? occt.ReadIgesFile(bytes, null) : occt.ReadStepFile(bytes, null);
  return meshesToGeom(result);
}

/** step | stp → "step"; iges | igs → "iges". */
export function occtKindForFilename(filename: string): OcctKind {
  return /\.(iges|igs)$/i.test(filename) ? "iges" : "step";
}
