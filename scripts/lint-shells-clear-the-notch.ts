#!/usr/bin/env tsx
// A shell that renders the page's main landmark (id={MAIN_ID}) pads its sides by var(--inset-left) and var(--inset-right), so a phone on its side keeps the shell's text and controls out of the notch.
//
// THE BUG THIS PREVENTS. Walk 61663 (2026-11-02, #9106): on iphone-landscape every console page drew Cobblr 42 px and super-admin 16 px from the left edge, inside the 59 px notch inset; AdminLayout never read the side insets.
//
// THE RULE. A file that renders `<main id={MAIN_ID}` (or id="main-content")
// is a shell: the page's chrome and its content start there, outside
// AppLayout's padded main. It must name both var(--inset-left) and
// var(--inset-right) in its markup. iOS reports the notch as a side inset
// only when the phone is on its side, so every upright walk passes a shell
// that never reads them. A shell that sits inside one that already pads (a
// module page drawn in AppLayout's main) says so with `// NOTCH: <which>`.
//
// THE BOUNDARY. It asks that the file reads the insets, not that each bar
// does: whether a pinned bar clears the notch is the walk's insetsClear
// check on iphone-landscape, measured on the page. Tests are not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-shells-clear-the-notch.ts   (pnpm lint shells-clear-the-notch)
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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    void line;
  }
  const at = lines.findIndex((l) => /<main\b[^>]*\bid=(\{MAIN_ID\}|"main-content")/.test(l));
  if (at < 0 || /\/\/ NOTCH: \S/.test(src)) return out;
  const missing = ["--inset-left", "--inset-right"].filter((v) => !src.includes(`var(${v}`));
  if (missing.length) out.push({ file, line: at + 1, what: `renders the main landmark but never pads by ${missing.map((v) => `var(${v})`).join(" or ")}` });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:shells-clear-the-notch - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Pad the shell's bars and main by the insets, e.g. pl-[max(1rem,var(--inset-left))] pr-[max(1rem,var(--inset-right))]; a shell nested in one that already pads says so with // NOTCH: <which shell>.");
  process.exit(1);
}
console.log(`lint:shells-clear-the-notch OK`);
