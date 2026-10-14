#!/usr/bin/env tsx
// Only Cobb's own chat asks the AI for the chat job; any other reading or organising call names its own job so it follows that job's order.
//
// THE BUG THIS PREVENTS. 2026-10-10: emailed receipts were read as chat, so choosing Sonnet for Cobb read every receipt with Sonnet
//
// A person's AI order is kept per job (Quick look, Thorough reading, Cobb
// chat, Organising and text, Search), and a call follows the order of the job
// its capability belongs to. Ten callers that were not Cobb asked for
// `capability: "chat"`, so they all followed Cobb's order without anyone
// choosing that.
//
// THE RULE. `capability: "chat"` in an AI call appears only in Cobb's own
// chat: core-ai's chat route and Cobb's reply in a discussion thread. Any
// other call names the job it does (read-document-text, identify-from-text,
// organise, or a capability of its own); a provider that does not declare it
// still answers through its chat (AI_CAPABILITY_FALLBACK). A genuine
// exception says why on the line or the line above: `// COBB-CHAT: <why>`.
//
// THE BOUNDARY. Only a literal `capability: "chat"` in api/src and modules
// source, tests and UI aside: a provider's own `chat: {...}` declaration and
// a variable holding "chat" (core-ai's askModel) are not calls naming it. No
// near-miss has tested it further yet.
//
// Proven red on receipt.ts chatExtract before it moved to read-document-text.
//
//   npx tsx scripts/lint-ai-chat-is-cobbs-alone.ts   (pnpm lint ai-chat-is-cobbs-alone)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

/** Cobb's own chat: the chat route, and Cobb answering in a discussion. */
const COBB = new Set(["modules/core-ai/src/api/chat.ts", "modules/core-discussion/src/api/cobb.ts"]);

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
  if (COBB.has(file.replaceAll("\\", "/")) || /\/ui\//.test(file)) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bcapability:\s*["'`]chat["'`]/.test(line)) continue;
    if (/\/\/ COBB-CHAT: \S/.test(line) || /\/\/ COBB-CHAT: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: 'asks for capability "chat" outside Cobb\'s chat, so it follows the Cobb chat order' });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:ai-chat-is-cobbs-alone - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use read-document-text, identify-from-text or organise (or a capability of its own)");
  process.exit(1);
}
console.log(`lint:ai-chat-is-cobbs-alone OK`);
