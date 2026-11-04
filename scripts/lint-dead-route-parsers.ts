#!/usr/bin/env tsx
// A module router must not mount its own express JSON body parser.
//
// WHY THIS IS A LINT: api/src/server.ts mounts a global express.json({limit:
// "1mb"}) ahead of every module router. By the time a router runs, any JSON
// body has already been parsed (or rejected) - so a json parser mounted on a
// module route is DEAD CODE that looks exactly like a fix. That mistake
// shipped: #1534 added expressJson({limit:"32mb"}) to the scan import route
// and its PR said the payload limit was raised; the live endpoint kept
// rejecting real envelopes with PayloadTooLargeError until the limit moved to
// the pre-mount block in server.ts, where the digifab relay and the Homebox
// import already do it.
//
// Text and multipart parsers are fine here - the global parser only consumes
// application/json - so only json() is flagged.
//
// The same dead limit comes in a second form: a schema that accepts more text
// than the parser will read, with no parser in the way to look at. The locations
// import promised 5 MB and answered 500 past 1 MB, and an emailed receipt with
// an attachment past about 750 KB never arrived. So a string schema promising a
// megabyte or more has to be served by a row of api/src/platform/large-bodies.ts
// that names its file and reads at least that much.
//
//   npx tsx scripts/lint-dead-route-parsers.ts   (pnpm run lint dead-route-parsers)

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { bytesOf, LARGE_BODIES } from "../api/src/platform/large-bodies.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const offenders: Array<{ file: string; line: number; text: string }> = [];
const unread: string[] = [];
const PROMISE_CHARS = 1_000_000;
const STRING_MAX = /(?:z\.string\(\)|assetRef)\s*(?:\.\w+\((?:[^()]|\([^()]*\))*\)\s*)*?\.max\(\s*([\d_]+)\s*\)/g;
const served = new Set<string>();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "tests") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

for (const file of walk(join(ROOT, "modules"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*")) return;
    // express.json( used as middleware, or the renamed import invoked.
    if (/\bexpress\.json\s*\(/.test(line) || /\bjson\s+as\s+expressJson\b/.test(line) || /\bexpressJson\s*\(/.test(line)) {
      offenders.push({ file, line: i + 1, text: line.slice(0, 100) });
    }
  });
}

const bigMaxes = execFileSync("git", ["grep", "--untracked", "-lE", "\\.max\\(\\s*[0-9_]{7,}", "--", "modules", "api/src"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 })
  .split("\n")
  .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.includes("/tests/"));
for (const rel of bigMaxes) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const m of text.matchAll(STRING_MAX)) {
    const chars = Number(m[1]!.replaceAll("_", ""));
    if (chars < PROMISE_CHARS) continue;
    const rows = LARGE_BODIES.filter((row) => row.promisedIn.includes(rel));
    served.add(rel);
    const line = text.slice(0, m.index).split("\n").length;
    if (!rows.length) unread.push(`${rel}:${line} accepts ${chars} characters, and no row of api/src/platform/large-bodies.ts names this file`);
    else if (rows.some((row) => bytesOf(row.limit) < chars)) unread.push(`${rel}:${line} accepts ${chars} characters, more than its row in large-bodies.ts reads`);
  }
}
for (const row of LARGE_BODIES) {
  const [, path] = row.example.split(" ");
  if (!row.path.test(path!.replaceAll(":", "x"))) unread.push(`large-bodies.ts: "${row.name}" does not match its own example ${row.example}`);
  for (const file of row.promisedIn) if (!served.has(file)) unread.push(`large-bodies.ts: "${row.name}" names ${file}, which promises nothing that big`);
}
if (unread.length) {
  console.error(`\n[lint:dead-route-parsers] ✗ ${unread.length} schema limit(s) no request can reach:\n`);
  for (const u of unread) console.error(`  ${u}`);
  console.error(`\nThe parser in api/src/server.ts refuses a body past its limit before the route runs. Add or raise a row in\napi/src/platform/large-bodies.ts, or lower the schema's limit to what the route really takes.\n`);
  process.exit(1);
}

if (offenders.length === 0) {
  console.log("[lint:dead-route-parsers] ✓ no module router mounts its own JSON body parser.");
  process.exit(0);
}
console.error(`\n[lint:dead-route-parsers] ✗ ${offenders.length} JSON parser(s) mounted inside a module router:\n`);
for (const o of offenders) console.error(`  ${relative(ROOT, o.file)}:${o.line}  ${o.text}`);
console.error(
  `\nThe app-level parser in api/src/server.ts has already consumed the JSON body by the\n` +
    `time a module router runs, so this parser never executes - a raised limit here is a fix\n` +
    `that does not fix. Add a row to api/src/platform/large-bodies.ts instead.\n`,
);
process.exit(1);
