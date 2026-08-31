#!/usr/bin/env tsx
// "I am about to build X — where does it go, and what should it look like?"
//
//   pnpm run where "a sheet for the locations page"
//   pnpm run where --path web/src/components/Foo.tsx   (what governs this file?)
//   pnpm run where --list                              (everything the map knows)
//
// Answers with: the directory, a REAL file to read first, the rules that will
// judge it, and the commands that check it. The rules are printed from each
// lint's OWN header, so this tool never holds a second copy of one.
//
// Why it exists: the answer used to arrive from `lint:all` after the work was
// done, and then arrive again the same way for the next person. See
// scripts/placement-registry.ts for what keeps the map honest.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLACEMENT, type PlacementRow } from "./placement-registry.js";

const ROOT = join(import.meta.dirname, "..");

/** The one-line rule a lint enforces, read from the lint's own header. */
function ruleOf(lintScript: string): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const cmd = pkg.scripts[lintScript];
  if (!cmd) return "(not a script in package.json)";
  const m = /(scripts\/[\w.-]+\.(?:ts|mjs|js))/.exec(cmd);
  if (!m) return "";
  const file = join(ROOT, m[1]!);
  if (!existsSync(file)) return "";
  // The first sentence of the file's leading comment IS the rule.
  const lines = readFileSync(file, "utf8").split("\n");
  const head: string[] = [];
  for (const l of lines) {
    if (l.startsWith("#!")) continue;
    if (!l.startsWith("//")) break;
    head.push(l.replace(/^\/\/\s?/, "").trim());
  }
  // The first SENTENCE, not the first colon: plenty of these headers open
  // "Guard: ..." or "The rule: ...", and cutting there prints the label
  // instead of the rule.
  const text = head.join(" ").trim().replace(/^(?:Guard|The rule|Rule|Lint)\s*:\s*/i, "");
  const stop = text.search(/(?<=\.)\s/);
  return (stop > 0 ? text.slice(0, stop) : text).slice(0, 200);
}

function score(row: PlacementRow, q: string): number {
  const hay = `${row.id} ${row.what} ${row.keywords.join(" ")}`.toLowerCase();
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let n = 0;
  for (const w of words) if (hay.includes(w)) n += 1;
  for (const k of row.keywords) if (q.toLowerCase().includes(k)) n += 2;
  return n;
}

function show(row: PlacementRow): void {
  console.log(`\n  ${row.what}`);
  console.log(`  ${"─".repeat(Math.min(70, row.what.length))}`);
  console.log(`  PUT IT IN   ${row.dir}`);
  console.log(`  COPY        ${row.exemplar}${existsSync(join(ROOT, row.exemplar)) ? "" : "   (MISSING — tell lint:placement)"}`);
  console.log(`  WHY         ${row.why}`);
  if (row.notes?.length) {
    console.log("  DECISIONS");
    for (const n of row.notes) console.log(`    · ${n}`);
  }
  if (row.lints.length) {
    console.log("  JUDGED BY");
    for (const l of row.lints) {
      const rule = ruleOf(l);
      console.log(`    · ${l}${rule ? `\n        ${rule}` : ""}`);
    }
    console.log(`  CHECK IT    pnpm run ${row.lints[0]}    (all of them: pnpm run lint:all)`);
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--list")) {
  for (const r of PLACEMENT) console.log(`${r.id.padEnd(24)} ${r.dir}`);
  process.exit(0);
}

const pathIdx = argv.indexOf("--path");
if (pathIdx >= 0) {
  // What governs a file that already exists (or a path you are about to write)?
  const p = (argv[pathIdx + 1] ?? "").replace(/^\.?\//, "");
  const hits = PLACEMENT.filter((r) => {
    const dir = r.dir.split(" ")[0]!.replace(/^\.?\//, "");
    return dir.includes("<name>")
      ? new RegExp(`^${dir.replace("<name>", "[^/]+").replace(/\/$/, "")}`).test(p)
      : p.startsWith(dir);
  });
  if (!hits.length) {
    console.log(`\n  Nothing in the map covers ${p}.`);
    console.log("  Either it is an ordinary file in an established place, or the map is missing a row —");
    console.log("  add one to scripts/placement-registry.ts.");
    process.exit(0);
  }
  hits.forEach(show);
  process.exit(0);
}

const q = argv.join(" ").trim();
if (!q) {
  console.log("usage: pnpm run where \"<what you are building>\" | --path <file> | --list");
  process.exit(2);
}
const ranked = PLACEMENT.map((r) => ({ r, n: score(r, q) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
if (!ranked.length) {
  console.log(`\n  Nothing in the map matches "${q}".`);
  console.log("  `--list` shows every kind it knows. If your case is genuinely new, add a row to");
  console.log("  scripts/placement-registry.ts — that is how the next person gets the answer for free.");
  process.exit(0);
}
show(ranked[0]!.r);
for (const alt of ranked.slice(1, 3)) console.log(`\n  also possible: ${alt.r.id} → ${alt.r.dir}`);
console.log("");
