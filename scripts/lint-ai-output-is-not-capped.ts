#!/usr/bin/env tsx
// An AI call asks for a reply the model can finish: a lower max_tokens needs a written reason beside it.
//
// THE BUG THIS PREVENTS. A 1024 token limit cut off a 25-line receipt and read as no line items (#9175).
//
// THE RULE. A limit is a ceiling and only what is written is paid for, so a low
// one saves nothing and throws away a reply already bought. Source that passes
// `max_tokens: <value>` fails unless one of the three lines above says
// `// max-tokens-ok: <why>`. The adapter's default is the model's own maximum.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The connection probe is the one
// real exception (it only asks whether a model answers), so it carries the reason.
// The Anthropic adapter's two lines carry theirs: one passes a caller's value
// through, the other obeys a ceiling the model stated. A type declaration
// (`max_tokens: number`) and a listing's field are not a limit and do not count.
//
// The web is outside the roots: a browser never calls a model directly.
//
// Proven red on the matchmaker's 2048 and the tidy suggestions' 1200.
//
//   npx tsx scripts/lint-ai-output-is-not-capped.ts   (pnpm lint ai-output-is-not-capped)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const own = line.trim();
    if (own.startsWith("//") || own.startsWith("*") || own.startsWith("/*")) continue;
    if (!/\bmax_tokens["']?\s*:\s*(?!number\b)[\w.]/.test(line)) continue;
    if (/\/\/ max-tokens-ok: \S/.test(lines.slice(Math.max(0, i - 3), i).join("\n"))) continue;
    out.push({ file, line: i + 1, what: "max_tokens set with no // max-tokens-ok: <why> above it" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:ai-output-is-not-capped - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:ai-output-is-not-capped OK`);
