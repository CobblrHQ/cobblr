#!/usr/bin/env node
// What does each test file cost the api suite, and does it need the api at all? (#5443)
//
//   node scripts/test-cost.mjs <run>            a CI run's `=== file cost ===` section (scripts/ci-log.sh)
//   node scripts/test-cost.mjs --file <tsv>     a table written by scripts/lib/vitest-file-cost-reporter.mjs
//   options: --top N (30)  --json
//
// Prints the slowest files, the total, and the api-suite files that reach neither the api nor a
// database: those run in the integration suite (each a worker, a fork's share of 8,000 test-seconds)
// while asserting pure logic the unit suite runs for almost nothing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The table out of a log or a tsv: rows of { ms, setup, collect, prepare, tests, file }. */
export function parseCosts(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => l.trim() === "=== file cost ===");
  const body = start < 0 ? lines : lines.slice(start + 1, lines.findIndex((l, i) => i > start && l.trim() === "=== end file cost ==="));
  return body
    .map((l) => l.split("\t"))
    .filter((c) => c.length === 6 && /^\d+$/.test(c[0]))
    .map(([ms, setup, collect, prepare, tests, file]) => ({ ms: +ms, setup: +setup, collect: +collect, prepare: +prepare, tests: +tests, file }));
}

/** Does a test file reach the running api or a database? Read from its source: a session, an http
 *  call, the api's base url, fetch, a pg client, the test-support doors, or the app's own helpers. */
export const REACHES_THE_API = /\b(signupFreshOrg|signupBlankOrg|isApiUp|http\s*[<(]|BASE\b|fetch\(|new\s+pg\.|from\s+["']pg["']|testSupport|ensureModule|enableAllModulesForTests|getTenantDb|meta\s*\.\s*(selectFrom|insertInto|updateTable|deleteFrom))/;
export function reachesTheApi(src) {
  return REACHES_THE_API.test(String(src));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const top = Number(opt("--top") ?? 30);
  const file = opt("--file");
  const run = args.find((a) => /^\d+$/.test(a));
  const text = file ? readFileSync(file, "utf8") : run ? execFileSync(join(ROOT, "scripts", "ci-log.sh"), [run, "test-full"], { encoding: "utf8", maxBuffer: 256 << 20 }) : "";
  const rows = parseCosts(text);
  if (!rows.length) {
    console.error("test-cost: no `=== file cost ===` table found (a run from before the reporter, or not a test job)");
    process.exit(2);
  }
  const src = (f) => { const p = join(ROOT, "api", f); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
  for (const r of rows) r.reaches = r.file.startsWith("tests/") ? reachesTheApi(src(r.file)) : null;
  const total = rows.reduce((n, r) => n + r.ms, 0);
  const pure = rows.filter((r) => r.reaches === false);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ total_ms: total, files: rows.length, pure_in_api_suite: pure }, null, 1));
    process.exit(0);
  }
  const s = (ms) => (ms / 1000).toFixed(1).padStart(7);
  console.log(`${rows.length} files, ${s(total)} s of tests (setup ${s(rows.reduce((n, r) => n + r.setup, 0))} s, collect ${s(rows.reduce((n, r) => n + r.collect, 0))} s)\n`);
  console.log(`slowest ${top}:`);
  for (const r of rows.slice(0, top)) console.log(`${s(r.ms)} s  ${String(r.tests).padStart(3)} tests  ${r.reaches === false ? "PURE " : "     "}${r.file}`);
  console.log(`\n${pure.length} api-suite file(s) reach neither the api nor a database (${s(pure.reduce((n, r) => n + r.ms, 0))} s): the unit suite is their place`);
  for (const r of pure.slice(0, top)) console.log(`${s(r.ms)} s  ${r.file}`);
}
