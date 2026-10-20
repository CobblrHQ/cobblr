#!/usr/bin/env tsx
// A toast or confirmation a person reads never names an HTTP status code: it says what happened to their thing in plain words.
//
// THE BUG THIS PREVENTS. #7604 (2026-10-20): turning off a printed QR label said 'scanning it now 404s', jargon to someone labelling their belongings, and the scan answers 410 anyway
//
// THE RULE. A string a person reads in a toast (toast.success, .error,
// .action, .info, .warning) or a confirmation's title or message (confirm({
// title, message })) has no HTTP status code in its literal text: no "404",
// "404s", "410". Say what the person will see instead: the label stops
// working, the link no longer opens. A number that is a count arrives through
// ${...} and is not judged. A line that must name one says why:
// `// status-ok: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only toasts and
// confirmations: an error a server sends carries its own words (and
// lint:action-copy-no-internal-nouns), and a status in a test, a log line or
// a comment is for an engineer. Two were in the tree when this was written:
// the QR label's "scanning it now 404s" (#7604) and a surface's "URL is now
// 404".
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-copy-never-names-an-http-status.ts   (pnpm lint copy-never-names-an-http-status)
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

const STATUS = /\b[45]\d\ds?\b/;
const LITERAL = /(["'`])((?:\\.|(?!\1).)*)\1/g;

/** The literal words of the strings on this stretch of code; ${...} is a value, not words. */
function literalText(code: string): string {
  return [...code.matchAll(LITERAL)].map((m) => (m[2] ?? "").replace(/\$\{[^}]*\}/g, "")).join(" ");
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  let inConfirm = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bconfirm\(\s*\{/.test(line)) inConfirm = 8;
    if (/\/\/ status-ok: \S/.test(line) || /\/\/ status-ok: \S/.test(lines[i - 1] ?? "")) { if (inConfirm) inConfirm--; continue; }
    const toast = /\btoast\.(?:success|error|action|info|warning)\((.*)$/.exec(line);
    const said = toast ? literalText(toast[1]!) : inConfirm && /^\s*(?:title|message):/.test(line) ? literalText(line) : "";
    if (inConfirm) inConfirm--;
    if (said && STATUS.test(said)) out.push({ file, line: i + 1, what: `a person reads "${said.trim().slice(0, 80)}", which names an HTTP status` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:copy-never-names-an-http-status - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("say what the person will see (it stops working, the link no longer opens), not the status code");
  process.exit(1);
}
console.log(`lint:copy-never-names-an-http-status OK`);
