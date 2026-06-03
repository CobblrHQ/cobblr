// Smoke test for the 3MF parser. Run: npx tsx src/scripts/test-3mf.ts
// Exercises both the XML mesh parse and the full unzip path (fflate runs in
// node). Exits non-zero on any assertion failure.
import { zipSync, strToU8 } from "fflate";
import assert from "node:assert/strict";
import { parse3mfModelXml, parse3mf } from "../ui/renderers/threemf-parse.js";

// A tetrahedron: 4 vertices, 4 triangles.
const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><mesh>
    <vertices>
      <vertex x="0" y="0" z="0"/>
      <vertex x="10" y="0" z="0"/>
      <vertex x="0" y="10" z="0"/>
      <vertex x="0" y="0" z="10"/>
    </vertices>
    <triangles>
      <triangle v1="0" v2="1" v3="2"/>
      <triangle v1="0" v2="1" v3="3"/>
      <triangle v1="1" v2="2" v3="3"/>
      <triangle v1="0" v2="2" v3="3"/>
    </triangles>
  </mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`;

// 1. XML parse.
const g = parse3mfModelXml(MODEL);
assert.equal(g.positions.length, 12, `positions: ${g.positions.length}, want 12`);
assert.equal(g.indices.length, 12, `indices: ${g.indices.length}, want 12`);
assert.deepEqual(g.indices.slice(0, 3), [0, 1, 2]);
assert.deepEqual(
  g.bounds,
  { minX: 0, minY: 0, maxX: 10, maxY: 10, minZ: 0, maxZ: 10 },
  "bounds",
);
assert.equal(g.empty, false);
assert.equal(g.colors, undefined, "uncoloured 3MF → no per-vertex colours");

// 2. Full unzip path: zip the model as 3D/3dmodel.model, then parse the .3mf bytes.
const zipped = zipSync({ "3D/3dmodel.model": strToU8(MODEL), "[Content_Types].xml": strToU8("<Types/>") });
const fromZip = parse3mf(zipped);
assert.deepEqual(fromZip.positions, g.positions, "zip path matches xml path");
assert.deepEqual(fromZip.indices, g.indices);

// 3. Two meshes merge with offset indices.
const twoMesh = MODEL.replace("</resources>", MODEL.match(/<object[\s\S]*?<\/object>/)![0] + "</resources>");
const merged = parse3mfModelXml(twoMesh);
assert.equal(merged.positions.length, 24, "two meshes → 8 vertices");
assert.equal(merged.indices.length, 24);
// second mesh's triangles are offset by the 4 vertices of the first.
assert.deepEqual(merged.indices.slice(12, 15), [4, 5, 6], "second mesh indices offset");

// 4. Colours: basematerials palette + two objects referencing different
//    pindexes → per-object per-vertex colours.
const COLORED = `<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="1">
      <base name="red" displaycolor="#FF0000"/>
      <base name="blue" displaycolor="#0000FF"/>
    </basematerials>
    <object id="1" pid="1" pindex="0"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
    <object id="2" pid="1" pindex="1"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object>
  </resources>
  <build><item objectid="1"/><item objectid="2"/></build>
</model>`;
const col = parse3mfModelXml(COLORED);
assert.ok(col.colors, "coloured 3MF → per-vertex colours present");
assert.equal(col.positions.length, 18, "2 objects × 3 verts");
assert.equal(col.colors!.length, col.positions.length, "one RGB per vertex");
assert.deepEqual(col.colors!.slice(0, 3), [1, 0, 0], "object 1 red");
assert.deepEqual(col.colors!.slice(9, 12), [0, 0, 1], "object 2 blue");

// 5. Garbage / empty → empty geometry, no throw.
assert.equal(parse3mfModelXml("not xml").empty, true);
assert.equal(parse3mf(zipSync({ "junk.txt": strToU8("hi") })).empty, true, "zip with no model → empty");

console.log("3MF parser smoke test: ALL PASS (tetra parse, zip path, multi-mesh offset, per-object colours, graceful empty)");
