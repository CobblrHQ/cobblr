#!/usr/bin/env tsx
// An action handler's summary, message or error is the sentence a person reads on the card; it names no kind id, action id or tool name, only the words the workspace calls things by.
//
// THE BUG THIS PREVENTS. After Do it a card read '"Yarn weight" on inventory:part: choices' and a refusal said 'check list_record_kinds' (walked on the rig, 2026-09-20, #3237)
//
// THE RULE. `actionSaid` (modules/core-ai/src/api/action-summary.ts) shows
// every action handler's `summary` (the kernel's) or `message` (most
// modules') as the result line a person reads, and a refusal's `error`
// reaches them the same way ("1 could not be: <the handler's error>"). So
// every one of those strings is user copy. In a handler file (a file whose
// name carries "handler", under api/src/platform or a module's src/api) a
// `summary:`, `message:` or `error:` template literal FAILS when it
// interpolates a value named like a kind id or an action id (`entityKind`,
// `entity_kind`, `kind`, `actionId`, `action_id`, `.id` of a wire/action,
// or `${result.def.entity_kind}`-style paths ending in those), or names a
// tool (`list_record_kinds`, `list_records`, `search_records`,
// `invoke_action`, `get_record`, `count_records`). It PASSES when the
// sentence carries the kind's words (`kindWords(orgId, kind)` beside the
// handlers gives the singular and the plural the workspace uses) and says
// a fact instead of pointing at a tool. A genuine exception (a string the
// model alone reads, never a person) opts out per line with
// `// ALLOW-INTERNAL-NOUN: <why no person ever reads this>`.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-action-copy-no-internal-nouns.ts   (pnpm run lint action-copy-no-internal-nouns)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/platform", "modules"];

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

/** Only a handler file: a module's HTTP routes speak JSON, not card copy. */
const isHandlerFile = (file: string): boolean => /handler/i.test(file.split("/").pop() ?? "") && /(^api\/src\/platform\/|^modules\/[^/]+\/src\/api\/)/.test(file);

/** An interpolation whose whole expression is a kind id or an action id by
 *  its name: `${entityKind}`, `${result.def.entity_kind}`, `${row.kind}`,
 *  `${wire.action_id}`. An id handed to a words function
 *  (`${(await kindWords(orgId, entityKind)).many}`) is the fix, not a hit. */
const INTERNAL_ID = /\$\{\s*(?:[\w$]+(?:\?\.|\.))*(?:entityKind|entity_kind|kind|kindId|kind_id|actionId|action_id)\s*\}/;
const TOOL_NAME = /\b(?:list_record_kinds|list_records|search_records|invoke_action|get_record|count_records)\b/;
const OPT_OUT = /\/\/ ALLOW-INTERNAL-NOUN: \S/;

/** The check. Return every violation in one file; an empty array is a pass.
 *  Every template literal in the statement that follows `summary:`,
 *  `summary =`, `message:` or `error:` is copy: the ternary that picked
 *  edit-field's sentence (`const summary = a ? x : y ? z : \`... on
 *  ${entityKind}\``) hid a kind id from the first version of this check,
 *  which read only a template written directly after the colon. */
function check(file: string, src: string): Violation[] {
  if (!isHandlerFile(file)) return [];
  const out: Violation[] = [];
  const seen = new Set<number>();
  for (const head of src.matchAll(/\b(summary|message|error|title)\s*[:=]\s*/g)) {
    const start = (head.index ?? 0) + head[0].length;
    const stop = src.indexOf(";\n", start);
    const statement = src.slice(start, stop === -1 ? start + 800 : Math.min(stop, start + 2000));
    for (const m of statement.matchAll(/`([^`]*)`/g)) {
      const at = start + (m.index ?? 0);
      if (seen.has(at)) continue;
      seen.add(at);
      const text = m[1] ?? "";
      const line = src.slice(0, at).split("\n").length;
      const context = src.split("\n").slice(line - 2, line + text.split("\n").length).join("\n");
      if (OPT_OUT.test(context)) continue;
      const id = INTERNAL_ID.exec(text);
      if (id) out.push({ file, line, what: `${head[1]} interpolates an internal id ${id[0]}: say the kind's words (kindWords) instead` });
      const tool = TOOL_NAME.exec(text);
      if (tool) out.push({ file, line, what: `${head[1]} names a tool (${tool[0]}): say the fact in words, a person cannot call a tool` });
      // "2 field(s)" is a template that never decided what it was counting;
      // the card read `Put 2 field(s) under "Buying" on Part` (#3255).
      const hedge = /\w\(s\)/.exec(text);
      if (hedge) out.push({ file, line, what: `${head[1]} hedges a plural (${hedge[0]}): count it (1 field, 3 fields) or name the things` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:action-copy-no-internal-nouns - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use kindWords(orgId, kind) beside the handlers for the kind's name, say the fact in words for a refusal, and never name a tool.");
  process.exit(1);
}
console.log(`lint:action-copy-no-internal-nouns OK`);
