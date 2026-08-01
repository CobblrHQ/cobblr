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
//   npx tsx scripts/lint-dead-route-parsers.ts   (npm run lint:dead-route-parsers)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const offenders: Array<{ file: string; line: number; text: string }> = [];

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

if (offenders.length === 0) {
  console.log("[lint:dead-route-parsers] ✓ no module router mounts its own JSON body parser.");
  process.exit(0);
}
console.error(`\n[lint:dead-route-parsers] ✗ ${offenders.length} JSON parser(s) mounted inside a module router:\n`);
for (const o of offenders) console.error(`  ${relative(ROOT, o.file)}:${o.line}  ${o.text}`);
console.error(
  `\nThe app-level parser in api/src/server.ts has already consumed the JSON body by the\n` +
    `time a module router runs, so this parser never executes - a raised limit here is a fix\n` +
    `that does not fix. Add a path-scoped pre-mount in api/src/server.ts instead (see the\n` +
    `digifab relay / core-import / core-scan pre-mounts there).\n`,
);
process.exit(1);
