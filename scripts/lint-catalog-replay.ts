#!/usr/bin/env tsx
// The api test lanes answer barcode lookups from api/tests/catalog-cassettes,
// never a live catalog, and every real code an api test scans has a cassette.
//
// THE BUG THIS PREVENTS. Main went red three times on the morning of
// 2026-09-14 on one test, scan-isbn-existing-book: it scanned a real ISBN,
// the product catalog answered with the title, the book's own bag (author,
// year) needed a second live call to Open Library, and that call was
// throttled. Green at 10:56, red at 11:03, on an identical tree (#2992). A
// verdict that depends on a third party's temper is not a verdict, and the
// deploy gate follows the verdict, so staging sat on the previous main for
// the day.
//
// THE RULE. Two halves, both mechanical:
//   1. Every api test lane (the `test` gate in ci.yml, `test-full` in
//      ci-tracker.yml) sets COBBLR_CATALOG_REPLAY_DIR to the cassette dir.
//      With it set, the product lookup chain and the ISBN/ASIN doors read
//      `<dir>/<code>.json` and never the network; a code with no cassette
//      is a miss (modules/core-scan/src/services/catalog-replay.ts). The
//      guarded image fetch reads `<dir>/images/<sha1 of the url>.<ext>`
//      the same way (the sandbox's ten book covers are recorded there; a
//      burst of them was throttled by the cover CDN the same morning).
//   2. Every REAL-LOOKING code an api test scans (`barcode: "<code>"`) has a
//      cassette. Real-looking: a 13-digit code that is not a store-internal
//      prefix (2xx), not all zeros, and passes the GTIN check digit; or an
//      ISBN-10 with a valid check. Synthetic codes (0000000000123, a 2xxx
//      store code, a wrong check digit) are misses by construction and need
//      none. A test that wants a real answer records it once:
//        COBBLR_CATALOG_REPLAY_DIR=api/tests/catalog-cassettes \
//        COBBLR_CATALOG_REPLAY_RECORD=1  (api up, then run the test)
//      A genuine exception (a test that asserts the MISS of a real code)
//      annotates the line: // CATALOG-MISS: <why a miss is the point>
//      A recorded cassette may be trimmed by hand to what the test reads
//      (a product catalog's raw payload carries offers and merchant links
//      nobody asserts on); `outcome`, `hit.title`, `hit.source` and, for a
//      decoded code, `hit.fields` + `hit.decoder_id` are the fixture.
//
// PROVE IT RED before you trust it green: drop the env line from ci.yml, or
// rename a cassette, and watch it fail.
//
//   npx tsx scripts/lint-catalog-replay.ts   (pnpm run lint:catalog-replay)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CASSETTES = "api/tests/catalog-cassettes";
const LANES = [".forgejo/workflows/ci.yml", ".forgejo/workflows/ci-tracker.yml"];
const ENV_LINE = /^\s*COBBLR_CATALOG_REPLAY_DIR:\s*\$\{\{\s*github\.workspace\s*\}\}\/api\/tests\/catalog-cassettes\s*$/m;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The GTIN check digit, the same arithmetic the scan router uses. */
function gtinChecksumOk(code: string): boolean {
  const d = code.split("").map(Number);
  const check = d.pop()!;
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i]! * w;
  return (10 - (sum % 10)) % 10 === check;
}

function isbn10Ok(code: string): boolean {
  if (!/^\d{9}[\dX]$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = code[i]!;
    sum += (c === "X" ? 10 : Number(c)) * (10 - i);
  }
  return sum % 11 === 0;
}

/** A code a live catalog could answer for. Everything else misses by construction. */
function looksReal(code: string): boolean {
  const c = code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (/^0+$/.test(c) || /^0{6,}/.test(c)) return false;
  if (/^\d{13}$/.test(c)) return !/^2/.test(c) && gtinChecksumOk(c);
  if (/^\d{12}$/.test(c)) return gtinChecksumOk(c);
  if (/^\d{8}$/.test(c)) return gtinChecksumOk(c);
  return isbn10Ok(c);
}

const violations: Violation[] = [];

for (const lane of LANES) {
  const src = readFileSync(lane, "utf8");
  if (!ENV_LINE.test(src)) {
    violations.push({ file: lane, line: 1, what: "the api test lane does not set COBBLR_CATALOG_REPLAY_DIR to api/tests/catalog-cassettes, so its barcode lookups reach live catalogs" });
  }
}

const cassettes = new Set(existsSync(CASSETTES) ? readdirSync(CASSETTES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : []);
for (const name of readdirSync("api/tests").filter((f) => /\.test\.ts$/.test(f))) {
  const file = join("api/tests", name);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/CATALOG-MISS:/.test(line)) continue;
    for (const m of line.matchAll(/barcode:\s*"([0-9A-Za-z -]+)"/g)) {
      const code = m[1]!.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
      if (!looksReal(code)) continue;
      if (!cassettes.has(code)) {
        violations.push({ file, line: i + 1, what: `scans real code ${code} with no ${CASSETTES}/${code}.json; record one (COBBLR_CATALOG_REPLAY_RECORD=1) or mark the line CATALOG-MISS: <why>` });
      }
    }
  }
}

if (violations.length) {
  console.error(`lint:catalog-replay - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A test's catalog is a fixture, not a service: record the answer once and replay it.");
  process.exit(1);
}
console.log(`lint:catalog-replay OK (${LANES.length} lanes replay from ${CASSETTES}; ${cassettes.size} cassette(s))`);
