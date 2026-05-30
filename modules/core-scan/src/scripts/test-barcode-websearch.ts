// Smoke + unit test for the barcode web-search fallback.
//   npx tsx modules/core-scan/src/scripts/test-barcode-websearch.ts
//
// Two halves:
//   1. Pure-function unit tests (deterministic, no network) — the
//      heuristic floor that must work even when the LLM/DDG are absent.
//   2. A tolerant real-DDG smoke — exercises the live search, but a
//      blocked/empty DDG only warns (DDG soft-rate-limits per IP); it
//      never fails the run, since the network isn't ours to guarantee.

import { cleanTitle, pickHeuristicName, pickImage } from "../services/barcode-websearch.js";
import { searchImages } from "../services/ddg-images.js";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`✓ ${label}`);
  } else {
    fail++;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── 1. pure helpers ──────────────────────────────────────────────────
const UPC = "049000028904";

ok(
  "cleanTitle strips the trailing ' | Retailer' segment",
  cleanTitle("DeWalt DCD771C2 20V Drill | Amazon.com", UPC) === "DeWalt DCD771C2 20V Drill",
);
ok(
  "cleanTitle removes the UPC + barcode filler words",
  cleanTitle(`UPC ${UPC} lookup DeWalt Drill`, UPC).replace(/\s+/g, " ").trim() === "DeWalt Drill",
);
ok(
  "pickHeuristicName takes the most-recurring title",
  pickHeuristicName(["DeWalt 20V Drill", "DeWalt 20V Drill", "Random foreign listing xyz"]) === "DeWalt 20V Drill",
);
ok(
  "pickHeuristicName prefers an English title over a foreign one",
  pickHeuristicName(["Перфоратор ударный сетевой", "Bosch Rotary Hammer Drill"]) === "Bosch Rotary Hammer Drill",
);
ok("pickHeuristicName returns null when nothing is usable", pickHeuristicName(["a", "x1", ""]) === null);
ok(
  "pickImage prefers the result whose title overlaps the name",
  pickImage(
    [
      { url: "http://x/other.jpg", thumb: "", title: "unrelated kitchen blender", source: "" },
      { url: "http://x/drill.jpg", thumb: "", title: "DeWalt 20V cordless drill", source: "" },
    ],
    "DeWalt 20V Drill",
  ) === "http://x/drill.jpg",
);

// ── 2. tolerant real-DDG smoke ───────────────────────────────────────
try {
  const results = await searchImages(UPC, 6);
  if (results.length === 0) {
    console.log("⚠ DDG returned 0 results (rate-limited or layout change) — smoke skipped, not failed");
  } else {
    ok("DDG search yields results with image URLs", results.every((r) => !!r.url));
    ok("DDG results carry titles (name candidates)", results.some((r) => r.title.trim().length > 0));
    console.log(`  (top title: "${results.find((r) => r.title)?.title ?? "—"}")`);
  }
} catch (err) {
  console.log(`⚠ DDG smoke threw (${(err as Error).message}) — skipped, not failed`);
}

console.log(`\n==== barcode-websearch — ${pass}/${pass + fail} unit checks ====`);
process.exit(fail ? 1 : 0);
