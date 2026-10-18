#!/usr/bin/env tsx
// A textarea a send clears when it lands is cleared only when it still holds what was sent: the onSuccess checks useSentWords' landed(), so words typed while the send was on its way are never erased.
//
// THE BUG THIS PREVENTS. #7167 (2026-10-18): a discussion comment that landed late erased the next comment, unsent, along with who it replied to.
//
// THE RULE. A mutation's onSuccess (in useMutation's options or a
// mutate call's) that sets a textarea's state to "" must ask the box first:
// the same onSuccess calls `.landed()` on a useSentWords handle, and the send
// marked it with `.sending()`. A clear that cannot lose words (the box is
// disabled while the send is on its way, say) says
// `// own-words: <why>` on the clearing line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only state bound as a
// <textarea>'s value in the same file: the first scan, over every input,
// found about a hundred one-shot create forms (a name, an email, a code)
// that close or reset once and are not where a person writes the next
// thing while the last is sending. A textarea is a composer: a comment, an
// announcement, a pasted manifest, a template. A clear outside an onSuccess
// (a click handler resetting a picker) is not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-landed-send-clears-only-its-own-words.ts   (pnpm lint a-landed-send-clears-only-its-own-words)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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

/** The text of a bracketed block starting at `open`, through its match. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** Every state this file binds as a textarea's value. */
function textareaStates(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/<(?:textarea|Textarea)\b[^>]*?\bvalue=\{(\w+)\}/gs)) out.add(m[1]!);
  return out;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!src.includes("onSuccess")) return out;
  const boxes = textareaStates(src);
  if (boxes.size === 0) return out;
  const handler = /\bonSuccess\s*:\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*/g;
  for (let m = handler.exec(src); m; m = handler.exec(src)) {
    const start = m.index + m[0].length;
    const body = src[start] === "{" ? block(src, start) : src.slice(start, src.indexOf("\n", start));
    if (/\.landed\(\)/.test(body)) continue;
    for (const clear of body.matchAll(/\bset([A-Z]\w*)\(\s*(?:""|''|``)\s*\)/g)) {
      const state = clear[1]![0]!.toLowerCase() + clear[1]!.slice(1);
      if (!boxes.has(state)) continue;
      const at = start + clear.index!;
      const lineNo = src.slice(0, at).split("\n").length;
      if (/\/\/ own-words: \S/.test(src.split("\n")[lineNo - 1] ?? "")) continue;
      out.push({ file, line: lineNo, what: `onSuccess clears the textarea ${state} without asking whether it still holds what was sent` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-landed-send-clears-only-its-own-words - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("mark the box with useSentWords(value).sending() as it is sent and clear it only if landed(); or say // own-words: <why> on the clearing line");
  process.exit(1);
}
console.log(`lint:a-landed-send-clears-only-its-own-words OK`);
