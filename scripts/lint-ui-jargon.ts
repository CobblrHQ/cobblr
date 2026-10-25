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
// genuinely-technical uses where the id IS the object (a DB-restore row
// count, a bundle composer's manifest rows, an operator console). Every entry
// is `{ key, why }`, the reason a sentence somebody can disagree with, and the
// lint refuses to run when one has no reason (scripts/lib/reasoned-baseline.ts).
// A red build is answered with the ONE entry to add, never a bulk write: the
// old `--write-baseline` recorded the whole current found-set, so somebody
// with three new offences who followed the message in front of them
// baselined all three plus whatever anybody added since (#3336). Clear a
// line and delete its entry; an entry whose line is gone fails too.
//
//   cd <repo> && npx tsx scripts/lint-ui-jargon.ts
//
// Local + CI, free, zero deps. COBBLR_LINT_ROOT points it at a fixture tree
// (the lint's own test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { entryToAdd, readReasonedBaseline, staleKeys } from "./lib/reasoned-baseline.js";

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const ROOTS = ["web/src", "modules"];
const BASELINE = join(ROOT, "scripts", "ui-jargon-baseline.json");
const BASELINE_SHOWN = "scripts/ui-jargon-baseline.json";
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
// A fallback after it (`{view?.entity_kind ?? "…"}`) prints the id all the
// same: the portal's view heading did (#7911).
// The browser tab is words too: the portal's view passed its kind id to
// usePageTitle, so a viewer's tab read "inventory:part" (#7978). A kind read
// straight into the title counts; one passed through a labeller does not.
const KIND_ID_OFFENSE =
  /(?<![=$\w])\{[\w.?!]*\b(kind|entity_kind|entityKind|view_type|viewType)(\s*\?\?\s*"[^"]*")?\}|\b(kind|entity_kind|entityKind|view_type|viewType)\.toUpperCase\(\)|usePageTitle\([^()]*?\.(kind|entity_kind|entityKind|view_type|viewType)\b(?!\s*[(.\w])/;

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
// A public surface's page told an owner deciding what to share that "readers
// go through exposableFields projection", that a filter was "resolver-
// dependent", and that a paused link "404s" (#7874): the code's words for
// what the person needed said plainly.
const PHRASE_OFFENSE = /exposableFields|resolver-dependent|\b404s\b|bundle installed|bundle uninstalled|ran a wire|wire failed|INVENTORY:PART|\bVENDING\b|\bGALLERY\b|the one that ran out|still had some|went bad|No AI to read|\(set it up\)/;

// A COUNT SHAPE as a default face: `0w · 9f`, `${wires.length}w · ${fields}f`.
// The 2026-09-13 blank-account review saw it on the install dialog, ahead of
// anything in plain words. Wires and fields are the bundle's plumbing; the
// person installing it wants the noun and what they can do first. The counts
// may live behind a details toggle, spelled out ("9 fields, 0 automations"),
// never as a single-letter abbreviation. Matches the source shape (template
// or literal): a number or a `}` closing an expression, `w`, the separator,
// then the same for `f`.
const COUNT_SHAPE_OFFENSE = /(\d+|\})\s*w\s*[·•|/]\s*(\d+|\$\{[^}]*\})\s*f\b/;

// An EVENT id or an ACTION id printed as text: the same routing-key mistake as
// a kind id, one row down. The dashboard's activity feed printed
// "core-scan.scan.received → identify-photo" in monospace as a first-timer's
// row, and on a phone the truncation read "ran an automation core-scan...."
// (#3299). A wire's row carries the action's own words (`said`,
// `action_label`, written by the module) and web/src/lib/activity-words.ts
// reads them; an id is never a word. So a JSX text slot printing a diff's
// `event` / `action` / an `event_name` / `action_id` / `actionId` /
// `eventName`, and `shortActionId(` printed as text, are offenses. Property
// access and attributes are fine, as for kind ids.
// (`{{event}}` inside a template string is a placeholder, not a slot: a
// slot is not preceded by another brace.)
const EVENT_ACTION_ID_OFFENSE =
  /(?<![=$\w{])\{[\w.?!]*\b(event|eventName|event_name|action_id|actionId|reactor|reactor_id)\b(\s*\?\?\s*"[^"]*")?\}(?!\})|\{shortActionId\(/;

// The code's own nouns in words a person reads: a "projection" of fields, a
// "resolver" that answers a filter (#7930, the first hour). A newcomer meets
// them and stops. Words only: in JSX text, or in a quoted sentence (a string
// with a space in it); a variable, an import or a property (`resolver.data`)
// is code.
const INTERNAL_WORD_OFFENSE =
  /> *[^<>{}]*(?<![.\w])(?:[Pp]rojections?|[Rr]esolvers?)(?!\.\w|[\w(])[^<>{}]*<|(["'`])(?=[^"'`]*\s)[^"'`$]*(?<![.\w])(?:[Pp]rojections?|[Rr]esolvers?)(?!\.\w|[\w(])[^"'`$]*\1/;

const OFFENSE = new RegExp(
  `${COUNT_OFFENSE.source}|${KIND_ID_OFFENSE.source}|${PHRASE_OFFENSE.source}|${COUNT_SHAPE_OFFENSE.source}|${EVENT_ACTION_ID_OFFENSE.source}|${INTERNAL_WORD_OFFENSE.source}`,
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

// The baseline is read BEFORE any source file: a list that cannot be audited
// guards nothing, so it does not get to.
const baseline = readReasonedBaseline(BASELINE, BASELINE_SHOWN);
if (!baseline.ok) {
  console.error(`✗ ui-jargon lint: ${BASELINE_SHOWN} does not state its case, so the lint will not run:\n`);
  for (const p of baseline.problems) console.error(`  ${p}`);
  console.error(`\nEvery entry is { "key": "<file>::<line>", "why": "<a sentence somebody can disagree with>" }.`);
  process.exit(1);
}

const found: Finding[] = [];
for (const root of ROOTS) {
  for (const file of tsxFiles(join(ROOT, root))) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((l, i) => {
        // A comment naming the jargon is the explanation, not the offense.
        if (/^\s*(\/\/|\*|\{\/\*|\/\*)/.test(l)) return;
        if (!OFFENSE.test(l)) return;
        const snippet = l.trim();
        const rel = relative(ROOT, file).split("\\").join("/");
        found.push({ file: rel, line: i + 1, snippet, key: `${rel}::${snippet}` });
      });
  }
}

const violations = found.filter((f) => !baseline.entries.has(f.key));
const stale = staleKeys(baseline.entries, new Set(found.map((f) => f.key)));

if (stale.length > 0) {
  console.error(`✗ ui-jargon lint: ${stale.length} entr${stale.length === 1 ? "y" : "ies"} in ${BASELINE_SHOWN} allow${stale.length === 1 ? "s" : ""} a line that no longer exists. Delete ${stale.length === 1 ? "it" : "them"}; an allowance for nothing is a habit:\n`);
  for (const k of stale) console.error(`  ${k.slice(0, 140)}`);
}

if (violations.length > 0) {
  console.error(`✗ ui-jargon lint: ${violations.length} NEW user-facing string(s) that are DB-speak, a kind id, a renderer id, or an event/action id:\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet.slice(0, 110)}`);
  console.error(`\nA count shown to a user must read in the item's OWN noun ("5 machines"), not "5 rows".
A kind or renderer id is a routing key, not a word: use useKindLabels(slug).collection(kind) /
.noun(kind) / .viewType(t) (web) or @cobblr/platform-contract/kind-label. An event or action id
is the same mistake one row down: a wire's activity row carries the action's own words
(diff.said, diff.action_label); read them through web/src/lib/activity-words.ts.

If, and only if, the id IS the object on this surface (a DB-restore row count, a bundle
composer's manifest rows, an operator console), add exactly ${violations.length === 1 ? "this entry" : "these entries"} to
${BASELINE_SHOWN}, in key order, each with a reason somebody can disagree with:
`);
  for (const v of violations) console.error(`${entryToAdd(v.key, "why the id is the object here, not a word the person reads")},`);
}

if (stale.length > 0 || violations.length > 0) process.exit(1);
console.log(`✓ ui-jargon lint: no new DB-speak in user-facing counts (${baseline.entries.size} baselined, each with a reason).`);
