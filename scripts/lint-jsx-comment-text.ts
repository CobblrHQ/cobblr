// A `//` comment in JSX CHILDREN position is not a comment - it is TEXT, and it
// renders on the page.
//
// JSX children are markup, not code, so the parser has no notion of a line
// comment there. Write
//
//   <button>
//     <Thumb />
//     // a caption over a tile that is itself the button
//     <span>Change</span>
//   </button>
//
// and the sentence appears in the interface, in the middle of the control. It
// looks exactly like a comment while you are writing it, TypeScript is happy,
// and every review reads past it - so the only thing that catches it is a user
// seeing the words on screen. That is how it shipped: three of them went out in
// one change and turned up in a screenshot of the edit-photo modal
// (2026-08-23).
//
// The fix is always the same shape: `{/* ... */}`.
//
// Exact, not heuristic: this parses the file and looks only at real JsxText
// nodes, so `//` inside a string, a URL, an attribute or a proper block comment
// is never flagged.

import { commentTextIn } from "./lib/jsx-comment-text.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "modules", "packages", "ops-console/src"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const violations: Array<{ file: string; line: number; text: string }> = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    for (const v of commentTextIn(file, readFileSync(file, "utf8"))) violations.push({ file: relative(ROOT, file), line: v.line, text: v.text });
  }
}

if (violations.length > 0) {
  console.error("lint:jsx-comment-text - a `//` comment in JSX children renders as visible text:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error("Wrap it: {/* ... */}\n");
  process.exit(1);
}

console.log("lint:jsx-comment-text ✓ no `//` or `/*` comments sitting in JSX children.");
