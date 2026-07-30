// Smoke test for the go-upc website tier (tryGoUpc) against the live
// site — run from the repo root:
//   npx tsx modules/core-scan/src/scripts/test-barcode-goupc.ts
// No DB or api needed. Honors the in-module 10s crawl-delay between
// cases, so 4 cases ≈ 30s. Exits non-zero on any expectation failure.
// NOT part of vitest — a live-scrape test in CI would be flaky and rude.

import { tryGoUpc } from "../services/barcode-lookup.js";

const CASES: Array<{ upc: string; expect: "hit" | "miss"; why: string; titleHas?: RegExp }> = [
  {
    upc: "784297017629",
    expect: "hit",
    why: "Southwire electrical box, the hardware case both free APIs miss",
    titleHas: /southwire/i,
  },
  {
    upc: "049000006346",
    expect: "hit",
    why: "Coca-Cola can, easy mainstream hit",
    titleHas: /coca[- ]?cola/i,
  },
  { upc: "784297999994", expect: "miss", why: "valid checksum, unknown → 'Product Not Found'" },
  { upc: "784297999999", expect: "miss", why: "bad checksum → HTTP 400 'Invalid Barcode'" },
];

async function main() {
  let failed = 0;
  let first = true;
  for (const c of CASES) {
    // tryGoUpc SKIPS (throws) rather than queue when the crawl-delay slot
    // is busy — so the script provides the pacing itself between cases.
    if (!first) await new Promise((r) => setTimeout(r, 10_500));
    first = false;
    try {
      const r = await tryGoUpc(c.upc);
      const got = r.kind === "hit" ? "hit" : "miss";
      let ok = got === c.expect;
      if (ok && r.kind === "hit" && c.titleHas && !c.titleHas.test(r.hit.title)) ok = false;
      console.log(
        `${ok ? "✓" : "✗"} ${c.upc} → ${got}${r.kind === "hit" ? `: "${r.hit.title}" [brand=${r.hit.brand} cat=${r.hit.category} img=${r.hit.image_url ? "yes" : "no"}]` : ""}  (${c.why})`,
      );
      if (!ok) failed++;
    } catch (e) {
      console.log(`✗ ${c.upc} → THREW: ${(e as Error).message}  (${c.why})`);
      failed++;
    }
  }
  console.log(failed ? `\n${failed} case(s) FAILED` : "\nall cases passed");
  process.exit(failed ? 1 : 0);
}

void main();
