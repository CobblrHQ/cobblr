#!/usr/bin/env tsx
// Action-predicate lint — an action declaring `appliesTo: { any: true }`
// matches EVERY entity kind, which is either deliberate (event/args-driven
// shapes that locate their subject from the payload; genuinely-universal
// verbs like add-to-list) or lazy (the "show it everywhere = noise" failure
// mode docs/architecture/traits.md warns about — and exactly what rotted the
// /actions page into twenty "nothing to edit" rows, 2026-07-03).
//
// The rule: a universal predicate must SAY WHY. Any `appliesTo: { any: true }`
// in a module manifest needs the marker "DELIBERATELY universal" in a comment
// within the 8 preceding lines. New actions either scope honestly
// (traits/kinds) or justify universality at the declaration site.
//
// And a predicate that is simply ABSENT is universal too - appliesTo defaults
// to { any: true } - so a user-invokable entity action with no appliesTo line
// fails as well. Workspace-scoped and wire-only actions are exempt: the first
// matches no kind by definition, the second is never a button.
//
//   cd <repo> && npx tsx scripts/lint-action-predicates.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "modules";
const MARKER = "DELIBERATELY universal";
const LOOKBACK = 8;

const findings: string[] = [];
for (const mod of existsSync(MODULES_DIR) ? readdirSync(MODULES_DIR) : []) {
  const manifest = join(MODULES_DIR, mod, "src", "module.ts");
  if (!existsSync(manifest)) continue;
  const text = readFileSync(manifest, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!/appliesTo:\s*\{\s*any:\s*true\s*\}/.test(line)) return;
    const context = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
    if (context.includes(MARKER)) return;
    findings.push(`  ${manifest}:${i + 1}`);
  });
  // The other way to be universal: say nothing. `appliesTo` DEFAULTS to
  // { any: true }, so an entity action that never mentions it is exactly as
  // universal as one that spells it out - and invisible to the check above.
  // That is how "Confirm a parcel is in hand", which acts on a receipt session
  // by id, became a button on every record in every workspace (2026-09-08).
  // A user-invokable, entity-scoped action must declare its predicate.
  for (const block of actionBlocks(text)) {
    if (/appliesTo\s*:/.test(block.body)) continue;
    if (/scope:\s*"workspace"/.test(block.body)) continue;
    if (/userInvokable:\s*false/.test(block.body)) continue;
    findings.push(`  ${manifest}:${block.line}  (${block.id}: no appliesTo at all, so it is universal)`);
  }
}

/** Each `{ id: "<module>:<name>", … }` in `exposes.actions`, as its own text.
 *  Split on the `id:` lines, which every action has and nothing else in the
 *  array does; a block runs to the next one. */
function actionBlocks(text: string): Array<{ id: string; line: number; body: string }> {
  const start = text.indexOf("actions: [");
  if (start < 0) return [];
  // The array ends at the first `],` back at its own indent.
  const indent = /(^|\n)([ \t]*)actions: \[/.exec(text)?.[2] ?? "";
  const endRe = new RegExp(`\\n${indent}\\],`);
  const endMatch = endRe.exec(text.slice(start));
  const arr = text.slice(start, endMatch ? start + endMatch.index : undefined);
  const out: Array<{ id: string; line: number; body: string }> = [];
  const idRe = /\n(\s*)id:\s*"([a-z0-9-]+:[a-z0-9_-]+)"/g;
  const hits = [...arr.matchAll(idRe)];
  hits.forEach((h, n) => {
    const from = h.index ?? 0;
    const to = n + 1 < hits.length ? (hits[n + 1]!.index ?? arr.length) : arr.length;
    const line = text.slice(0, start + from).split("\n").length;
    out.push({ id: h[2]!, line, body: arr.slice(from, to) });
  });
  return out;
}

if (findings.length > 0) {
  console.error(`✗ action-predicate lint: ${findings.length} undocumented universal predicate(s).\n`);
  console.error(findings.join("\n"));
  console.error(`\nAn any:true action offers itself on EVERY entity kind. Either scope it honestly —
appliesTo: { traits: [...] } (open-set; tunable on /actions) or { kinds: [...] }
(module-internal precision) — or, if it's an event/args-driven shape with no
entity source, keep any:true and add a comment containing "${MARKER}"
within ${LOOKBACK} lines above, saying why. See docs/architecture/traits.md.`);
  process.exit(1);
}
console.log("✓ action-predicate lint: every universal predicate is documented.");
