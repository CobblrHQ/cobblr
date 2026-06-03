// Smoke test for the DXF parser. Run: npx tsx src/scripts/test-dxf.ts
// (pure parser, no browser needed). Exits non-zero on any assertion failure.
import { parseDxf } from "../ui/renderers/dxf-parse.js";
import assert from "node:assert/strict";

// Minimal DXF: one LINE, one CIRCLE, one closed 3-vertex LWPOLYLINE (triangle).
const dxf = [
  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "10", "0.0", "20", "0.0", "11", "10.0", "21", "0.0",
  "0", "CIRCLE", "10", "5.0", "20", "5.0", "40", "2.0",
  "0", "LWPOLYLINE", "90", "3", "70", "1",
  "10", "0.0", "20", "0.0",
  "10", "10.0", "20", "0.0",
  "10", "10.0", "20", "10.0",
  "0", "ENDSEC", "0", "EOF", "",
].join("\n");

const g = parseDxf(dxf);

// 1 LINE + 3 polyline edges (2 spans + 1 closing edge) = 4 segments.
assert.equal(g.segs.length, 4, `segs: got ${g.segs.length}, want 4`);
// 1 circle.
assert.equal(g.arcs.length, 1, `arcs: got ${g.arcs.length}, want 1`);
assert.deepEqual(
  { ...g.arcs[0] },
  { cx: 5, cy: 5, r: 2, a0: 0, a1: 360 },
  "circle parsed",
);
assert.deepEqual(g.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, "bounds");
assert.equal(g.empty, false);

// Empty / non-DXF input degrades gracefully (empty geometry, never throws).
const empty = parseDxf("not a dxf file\njust text");
assert.equal(empty.empty, true, "garbage input → empty");

// A bare circle, to confirm single-entity files work.
const circleOnly = parseDxf(["0", "CIRCLE", "10", "1", "20", "2", "40", "3", "0", "EOF", ""].join("\n"));
assert.equal(circleOnly.arcs.length, 1);
assert.deepEqual(circleOnly.bounds, { minX: -2, minY: -1, maxX: 4, maxY: 5 }, "circle bounds");

console.log("DXF parser smoke test: ALL PASS (4 segs, 1 circle, correct bounds, graceful on garbage)");
