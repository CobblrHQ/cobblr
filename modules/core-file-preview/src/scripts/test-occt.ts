// Smoke test for the STEP/IGES parse path. occt-import-js (OpenCASCADE WASM)
// runs in node, so we tessellate real cube fixtures and check the merged
// geometry + the per-solid colour gate.
// Run: npx tsx src/scripts/test-occt.ts   Exits non-zero on failure.
import occtFactory from "occt-import-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readOcct, meshesToGeom } from "../ui/renderers/occt-parse.js";
import type { OcctResult } from "occt-import-js";

const fx = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url))));

const occt = await occtFactory(); // node auto-locates the wasm beside the package

function checkCube(geom: ReturnType<typeof readOcct>, label: string) {
  assert.equal(geom.empty, false, `${label}: produced geometry`);
  assert.ok(geom.positions.length % 3 === 0 && geom.positions.length > 0, `${label}: positions xyz-aligned`);
  assert.ok(geom.indices.length % 3 === 0 && geom.indices.length > 0, `${label}: indices triangle-aligned`);
  const verts = geom.positions.length / 3;
  assert.ok(Math.max(...geom.indices) < verts, `${label}: indices in range`);
  const b = geom.bounds;
  assert.ok(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ, `${label}: non-degenerate`);
  return verts;
}

// STEP + IGES both tessellate.
const step = readOcct(occt, fx("cube.step"), "step");
const stepVerts = checkCube(step, "STEP");
const iges = readOcct(occt, fx("cube.igs"), "iges");
const igesVerts = checkCube(iges, "IGES");
// A single-colour part keeps the default material (no per-vertex colours).
assert.equal(step.colors, undefined, "single-colour STEP → no vertex colours");

// Colour gate (pure): same colour across solids → no colours; distinct → colours.
const mkMesh = (color: number[]): OcctResult["meshes"][number] => ({
  color,
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
  index: { array: [0, 1, 2] },
});
const mono = meshesToGeom({ success: true, root: null, meshes: [mkMesh([0.5, 0.5, 0.5]), mkMesh([0.5, 0.5, 0.5])] });
assert.equal(mono.colors, undefined, "uniform colour → no vertex colours");
const multi = meshesToGeom({ success: true, root: null, meshes: [mkMesh([1, 0, 0]), mkMesh([0, 0, 1])] });
assert.ok(multi.colors, "multi-colour assembly → vertex colours present");
assert.equal(multi.colors!.length, multi.positions.length, "one RGB per vertex");
assert.deepEqual(multi.colors!.slice(0, 3), [1, 0, 0], "first solid red");
assert.deepEqual(multi.colors!.slice(9, 12), [0, 0, 1], "second solid blue");

// Failure / empty degrade gracefully.
assert.equal(meshesToGeom({ success: false, root: null, meshes: [] }).empty, true);
assert.equal(meshesToGeom({ success: true, root: null, meshes: [] }).empty, true);

console.log(`occt parser smoke test: ALL PASS (STEP ${stepVerts} verts, IGES ${igesVerts} verts, colour gate ok)`);
