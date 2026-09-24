#!/usr/bin/env tsx
// A record header takes the record's own kind from the page, never a literal,
// so it lists the same actions as the page's strip.
//
// THE BUG THIS PREVENTS. A book on a Bookshelf showed two identical PRINT
// LABEL buttons (#3591, 2026-09-24). The item page passed its header chips a
// literal `kind="inventory:part"` and its strip of verbs the page's own kind,
// `bookshelf:item`. The two asked the platform about two different kinds, so
// the header offered the plain label action while the strip offered the
// Bookshelf's own, and the book got two labels with two QRs. The header and
// the strip dedupe each other only when they ask about one kind.
//
// THE RULE. `<RecordHeaderChips kind=...>` takes an expression from the page
// (the kind the page is showing), never a string literal. A literal names the
// module's kind, which is the wrong one on every instance of that module.
//
// THE BOUNDARY. Only the header component's own `kind` prop: other
// components legitimately name a fixed kind (a scan-into link carries the
// module kind on purpose, since a container is addressed by its record).
// Nothing has tested the boundary beyond that yet.
//
// Proven red on the item page as it stood before #3591.
//
//   npx tsx scripts/lint-record-header-kind.ts   (pnpm lint record-header-kind)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "web/src", "packages"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  // The opening tag can run over several lines; read each one whole.
  const tag = /<RecordHeaderChips\b[^>]*>/g;
  for (const m of src.matchAll(tag)) {
    if (/\bkind\s*=\s*["'`]/.test(m[0]) || /\bkind\s*=\s*\{\s*["'`]/.test(m[0])) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ file, line, what: "RecordHeaderChips given a literal kind: pass the kind the page shows, so the header and the strip ask about one kind" });
    }
  }
  void lines;
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:record-header-kind - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Pass the page's own kind (the one its EntityActionsBar gets).");
  process.exit(1);
}
console.log(`lint:record-header-kind OK`);
