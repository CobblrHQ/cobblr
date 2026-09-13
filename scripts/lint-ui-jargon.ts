#!/usr/bin/env tsx
// UI-jargon lint. A user-facing COUNT must read in the item's OWN noun ("5
// machines"), never DB-speak ("5 rows" / "5 records" / "5 entities"). That leaked
// into the dashboard + Views count labels (reported 2026-07-11: "you should use the
// nouns that came with the items, not 5 rows").
//
// Flags a JSX / template count label — `{expr} rows|records|entities` — in a
// .tsx file. The `rows={N}` textarea/prop ATTRIBUTE is not a label and is
// excluded (the offense word must not be followed by `=`). Derive the noun from
// the kind instead (e.g. `entity_kind.split(":")[1]` -> "machine").
//
// Runs against a committed BASELINE (scripts/ui-jargon-baseline.json) of
// genuinely-technical uses where "rows" is honest (a DB-restore row count, a
// CSV-file row count). Clear one and drop it from the baseline, or add a new
// legitimately-technical one with `--write-baseline`. Any NEW jargon fails.
//
//   cd <repo> && npx tsx scripts/lint-ui-jargon.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules"];
const BASELINE = join("scripts", "ui-jargon-baseline.json");
// A `}` closing a JSX expr / template `${}`, then the jargon noun, NOT followed
// by `=` (a `rows={8}` attribute) or `.`/`[` (a `.rows` / `["rows"]` access).
const COUNT_OFFENSE = /\}\s*(rows|records|entities)\b(?!\s*[=.[])/;

// A KIND ID or a RENDERER ID printed as text. The 2026-09-12 new-user review
// saw `bookshelf:item`, `groceries:item`, GALLERY, VENDING and INVENTORY:PART
// as chips, and a bin sheet calling a book "part". A kind id is a routing
// key; the person sees a collection with a name and a noun, and
// @cobblr/platform-contract/kind-label answers both. So: a JSX text slot
// `>{x.kind}<` / `{view.entity_kind}` / `{v.view_type}` fails, and so does
// a `.toUpperCase()` on one of those. Property ACCESS is fine (`kind={k}`,
// `key={e.kind}`, a filter); only printing it as words is the offense.
// A `{x.kind}` slot NOT preceded by `=` or `$` is JSX text: an attribute
// (`entityKind={kind}`, `key={e.kind}`) is a value, a template `${e.kind}` is
// a key, and a destructuring `{ kind }` has the space this pattern refuses.
const KIND_ID_OFFENSE =
  /(?<![=$\w])\{[\w.?!]*\b(kind|entity_kind|entityKind|view_type|viewType)\}|\b(kind|entity_kind|entityKind|view_type|viewType)\.toUpperCase\(\)/;

// Phrases the review called out by name. "ran a wire" is a verb nobody
// outside this codebase uses; the activity row says "ran an automation".
// The pantry's re-buy verbs ("Replaced the one that ran out", "still had
// some", "went bad") are words for STOCK, and a surface that hardcodes them
// prints them under a book (the 2026-09-13 review); they live in the
// contract's repurchaseWords, chosen by the collection's face, and nowhere
// in a component.
// "No AI to read this ... (set it up)" is the sentence for a person with NO
// way to identify a photo. It rendered under every card for a person whose
// own connection reads photos, because the flag it read was a deployment
// switch (the 2026-09-13 review, #2845). The one place that may say it is
// baselined by line and guarded by identify_available; a new one fails here.
const PHRASE_OFFENSE = /ran a wire|wire failed|INVENTORY:PART|\bVENDING\b|\bGALLERY\b|the one that ran out|still had some|went bad|No AI to read|\(set it up\)/;

// A COUNT SHAPE as a default face: `0w · 9f`, `${wires.length}w · ${fields}f`.
// The 2026-09-13 blank-account review saw it on the install dialog, ahead of
// anything in plain words. Wires and fields are the bundle's plumbing; the
// person installing it wants the noun and what they can do first. The counts
// may live behind a details toggle, spelled out ("9 fields, 0 automations"),
// never as a single-letter abbreviation. Matches the source shape (template
// or literal): a number or a `}` closing an expression, `w`, the separator,
// then the same for `f`.
const COUNT_SHAPE_OFFENSE = /(\d+|\})\s*w\s*[·•|/]\s*(\d+|\$\{[^}]*\})\s*f\b/;

const OFFENSE = new RegExp(
  `${COUNT_OFFENSE.source}|${KIND_ID_OFFENSE.source}|${PHRASE_OFFENSE.source}|${COUNT_SHAPE_OFFENSE.source}`,
);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    // A test that asserts a word is absent has to name it; a test is not a surface.
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  snippet: string;
  key: string;
}

const found: Finding[] = [];
for (const root of ROOTS) {
  for (const file of tsxFiles(root)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((l, i) => {
        // A comment naming the jargon is the explanation, not the offense.
        if (/^\s*(\/\/|\*|\{\/\*|\/\*)/.test(l)) return;
        if (!OFFENSE.test(l)) return;
        const snippet = l.trim();
        found.push({ file, line: i + 1, snippet, key: `${file}::${snippet}` });
      });
  }
}

if (process.argv.includes("--write-baseline")) {
  const keys = [...new Set(found.map((f) => f.key))].sort();
  writeFileSync(BASELINE, JSON.stringify(keys, null, 2) + "\n");
  console.log(`[lint:ui-jargon] wrote baseline with ${keys.length} entr${keys.length === 1 ? "y" : "ies"}.`);
  process.exit(0);
}

let baseline: Set<string>;
try {
  baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
} catch {
  baseline = new Set();
}
const violations = found.filter((f) => !baseline.has(f.key));

if (violations.length > 0) {
  console.error(`✗ ui-jargon lint: ${violations.length} NEW user-facing string(s) that are DB-speak, a kind id, or a renderer id:\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet.slice(0, 110)}`);
  console.error(`\nA count shown to a user must read in the item's OWN noun ("5 machines"), not "5 rows".
A kind or renderer id is a routing key, not a word: use useKindLabels(slug).collection(kind) /
.noun(kind) / .viewType(t) (web) or @cobblr/platform-contract/kind-label. If this is a
genuinely technical string (a DB-restore row count, a config code), add it with:
  npx tsx scripts/lint-ui-jargon.ts --write-baseline`);
  process.exit(1);
}
console.log(`✓ ui-jargon lint: no new DB-speak in user-facing counts (${baseline.size} baselined).`);
