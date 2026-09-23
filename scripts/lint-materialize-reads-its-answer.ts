#!/usr/bin/env tsx
// A script that installs a bundle it depends on reads the answer: through materializeBundle(), which stops on anything but 2xx, or by keeping the response to assert on.
//
// THE BUG THIS PREVENTS. Three scripts asked /quickstart/materialize for
// "cobblr.flagship.bookshelf", an id that has never existed. The API answered
// 404 and every caller discarded it, so each carried on judging book barcodes
// in a workspace with no Bookshelf in it, from 2026-09-13 for nine days, and
// every book verdict in that window was about the wrong setup (#3472). The id
// was a typo; the discarded answer is what let the typo run for nine days, and
// it was the same discard in eleven places across eight files.
//
// THE RULE. In e2e/ and scripts/, a call to /quickstart/materialize either goes
// through materializeBundle() (scripts/lib/materialize-bundle.mjs), or keeps
// its response (`const r = await api(...)`, `return await ...`) so the caller
// can assert on it. A bare `await api("POST", "/quickstart/materialize", …)`
// whose answer goes nowhere is refused. A kept response that is then never
// read is beyond what a line-level rule can see; the helper is the default for
// that reason.
//
// PROVED RED 2026-09-22 against main (eleven discarded answers in eight
// files); green once they went through materializeBundle().
//
//   npx tsx scripts/lint-materialize-reads-its-answer.ts   (pnpm run lint:materialize-reads-its-answer)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["e2e", "scripts"];
const HELPER = join("scripts", "lib", "materialize-bundle.mjs");

function* walk(dir: string): Generator<string> {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === "node_modules" || name === "_tmp" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(mjs|js|ts)$/.test(name) && !/\.test\.(mjs|ts)$/.test(name)) yield p;
  }
}

const violations: { file: string; line: number; text: string }[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (file === HELPER || file.endsWith("lint-materialize-reads-its-answer.ts")) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!line.includes('"/quickstart/materialize"')) return;
      const before = line.slice(0, line.indexOf("await"));
      if (/(=|return)\s*$/.test(before)) return; // the answer is kept
      violations.push({ file, line: i + 1, text: line.trim().slice(0, 110) });
    });
  }
}

if (violations.length) {
  console.error(`lint:materialize-reads-its-answer - ${violations.length} install(s) whose answer goes nowhere:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(
    "A refused install carried past is how nine days of book verdicts were judged with no Bookshelf installed.\n" +
      "Use: await materializeBundle(api, \"<bundle id>\")   (scripts/lib/materialize-bundle.mjs), which stops on non-2xx.",
  );
  process.exit(1);
}
console.log("lint:materialize-reads-its-answer OK (every bundle install a script depends on reads its answer)");
