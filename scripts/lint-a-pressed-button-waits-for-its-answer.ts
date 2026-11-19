#!/usr/bin/env tsx
// A button that sends a write (onClick calls m.mutate) is disabled while that write is on its way (disabled names m.isPending), so a second tap cannot send it again.
//
// THE BUG THIS PREVENTS. #9583: a double tap on a create sent its write twice; the server's key made it one record, but 119 buttons still took the second tap, 2026-11-19
//
// THE RULE. A `<button>` whose onClick calls `m.mutate(` or `m.mutateAsync(`,
// where this file assigns `m` from useMutation, carries a `disabled` that
// names `m.isPending` (or `m.isLoading`). A button already disabled for its
// own reason adds `|| m.isPending`. A button that is right to take a second
// press while the first is on its way says so on the line above it:
// `// repeat-ok: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only buttons whose own
// onClick sends the write: a form's Enter is the submit button's, which this
// judges when its onClick sends; a handler that calls a function which then
// mutates is not followed (one level deep is where the 119 were). A disabled
// that names a local flag the handler sets for the same write (`busy`,
// `saving`, `sending`, `pending`) passes: those already wait.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-pressed-button-waits-for-its-answer.ts   (pnpm lint a-pressed-button-waits-for-its-answer)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** Each `<button ...>` opening tag: its start and its text, braces kept whole. */
function* buttonTags(src: string): Generator<{ at: number; tag: string }> {
  const re = /<button\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + 7;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    yield { at: m.index, tag: src.slice(m.index, i + 1) };
  }
}

/** The expression inside `disabled={...}`, braces kept whole. */
function disabledOf(tag: string): string {
  const at = tag.search(/(?<![-\w])disabled=\{/);
  if (at < 0) return /(?<![-\w])disabled(\s|>|\/)/.test(tag) ? "true" : "";
  let i = tag.indexOf("{", at) + 1;
  const start = i;
  for (let depth = 1; i < tag.length && depth > 0; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}") depth--;
  }
  return tag.slice(start, i - 1);
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const { at, tag } of buttonTags(src)) {
    const sends = /onClick=\{[\s\S]*?\b(\w+)\.mutate(?:Async)?\(/.exec(tag);
    if (!sends) continue;
    const m = sends[1]!;
    if (!new RegExp(`\\b${m}\\s*=\\s*useMutation\\b`).test(src)) continue;
    const dis = disabledOf(tag);
    if (new RegExp(`\\b${m}\\.(isPending|isLoading)\\b`).test(dis) || /\b\w*(busy|saving|sending|pending|inFlight)\w*\b/i.test(dis)) continue;
    const line = src.slice(0, at).split("\n").length;
    if (/\/\/\s*repeat-ok: \S|\{\/\*\s*repeat-ok: \S/.test(lines[line - 2] ?? "")) continue;
    out.push({ file, line, what: `a button that sends ${m} takes a second press while ${m} is on its way` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-pressed-button-waits-for-its-answer - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Add disabled={m.isPending} (or || m.isPending to the disabled already there), or // repeat-ok: <why> above the button");
  process.exit(1);
}
console.log(`lint:a-pressed-button-waits-for-its-answer OK`);
