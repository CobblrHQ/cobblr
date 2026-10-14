#!/usr/bin/env tsx
// A record's custom fields are read on their own, never spread into one bag with the record's built-in columns, where a column can stand in for a custom field of the same name.
//
// THE BUG THIS PREVENTS. 2026-09-29: the dashboard's move offer read an inventory row's built-in state as Spools' custom state and offered every part in a filament workspace to Spools
//
// THE RULE. Fails on one object built from a record and that same record's
// custom fields, spread side by side: `{ ...r, ...r.metadata }`, or with the
// record cast (`...(r as Record<string, unknown>), ...(r.metadata ?? {})`),
// across up to three lines. A reader of that bag cannot tell the record's own
// `state` or `location_id` from a custom field of that name, and a table that
// defines one then "matches" every row. Read the custom fields alone; where a
// bag of both is genuinely wanted (a display that shows everything), say why
// on the line: `// custom-fields-apart-ok: <reason>`.
//
// THE BOUNDARY. Only the same identifier on both sides: `{ ...defaults,
// ...row.metadata }` builds from two different things and is not the shape.
// Tests are out of scope; a test composing a fixture is not a reader.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-custom-fields-apart.ts   (pnpm lint custom-fields-apart)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages"];

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
  const SPREAD = /\.\.\.\(?\s*([A-Za-z_$][\w$]*)(?:\s+as\s+[^)]*)?\s*\)?\s*[,}\n]/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const window = lines.slice(i, i + 3).join("\n");
    SPREAD.lastIndex = 0;
    for (const m of line.matchAll(SPREAD)) {
      const id = m[1]!;
      const own = new RegExp(`\\.\\.\\.\\(?\\s*${id.replace(/\$/g, "\\$")}\\??\\.(metadata|custom_fields)\\b`);
      const rest = window.slice(window.indexOf(m[0]) + m[0].length);
      if (!own.test(rest)) continue;
      const ok = lines.slice(Math.max(0, i - 1), i + 3).some((l) => /custom-fields-apart-ok:\s*\S/.test(l));
      if (ok) continue;
      out.push({ file, line: i + 1, what: `\`...${id}\` spread beside \`...${id}.metadata\`: its own columns read as its custom fields` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:custom-fields-apart - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("read the custom fields (the record's metadata) alone; offerRowFrom in web/src/lib/table-move-offer.ts is the shape");
  process.exit(1);
}
console.log(`lint:custom-fields-apart OK`);
