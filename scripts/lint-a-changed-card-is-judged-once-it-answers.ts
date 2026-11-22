#!/usr/bin/env tsx
// A walk step that presses something and then judges a card gone by its words (a data-testid selector with :has-text and max 0) also waits for, or checks, that same card showing what it shows now.
//
// THE BUG THIS PREVENTS. renewal-term-undo-light went red on desktop in the 2026-11-21 nightly: the expiry line had the term back and the term card answered a moment later (#9561)
//
// THE RULE. The walk judges a ceiling alone ("max": 0) once, as soon as the
// step's waits are met (checks/selector.mjs). After a press, two parts of a
// page can be refreshed by two reads that answer at different moments: the
// step waited for one, and the card it then judged gone had not answered
// yet. So a step that clicks, presses or taps and then judges
// `[data-testid=X]:has-text(...)` with "max": 0 also holds X positively in the
// same step: a `waitFor` selector or an expected selector (no max 0) that
// starts with `[data-testid=X]`. Passes: renewal-term-undo-light, which waits
// for the term card to show "Nov 30, 2027" before judging "Dec 31, 2027" gone.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a data-testid card
// judged by its words. A ceiling that means "never offered" (a button an
// admin must not see, `button:has-text("Connect a printer")`) is not a card
// that changes, and eleven such checks were left out on purpose. Steps that
// press nothing are not judged: nothing was refreshed under them.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-changed-card-is-judged-once-it-answers.ts   (pnpm lint a-changed-card-is-judged-once-it-answers)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["e2e/walks"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (name.endsWith(".json") && !isEmbeddedPayload(p)) yield p;
  }
}

interface Check { selector?: unknown; max?: unknown; min?: unknown }
interface Step { name?: string; do?: Array<Record<string, unknown>>; expect?: Check[] }

const CARD_GONE = /^(\[data-testid=[^\]]+\]):has-text\(/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  let spec: { steps?: Step[] };
  try {
    spec = JSON.parse(src);
  } catch {
    return [];
  }
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const step of spec.steps ?? []) {
    const acts = step.do ?? [];
    if (!acts.some((a) => a.click || a.press || a.tap)) continue;
    const waits = acts.map((a) => (a.waitFor as { selector?: unknown } | undefined)?.selector).filter((s): s is string => typeof s === "string");
    for (const c of step.expect ?? []) {
      if (typeof c.selector !== "string" || c.max !== 0 || c.min !== undefined) continue;
      const card = CARD_GONE.exec(c.selector)?.[1];
      if (!card) continue;
      const held = waits.some((w) => w.startsWith(card)) || (step.expect ?? []).some((o) => o !== c && typeof o.selector === "string" && o.selector.startsWith(card) && o.max !== 0);
      if (held) continue;
      const at = lines.findIndex((l) => l.includes(JSON.stringify(c.selector).slice(1, -1)));
      out.push({ file, line: at + 1, what: `step "${step.name ?? "?"}" judges ${card} gone by its words but never waits for that card to answer` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-changed-card-is-judged-once-it-answers - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add a waitFor or a positive selector check on the same [data-testid=…] with the words it should show now");
  process.exit(1);
}
console.log(`lint:a-changed-card-is-judged-once-it-answers OK`);
