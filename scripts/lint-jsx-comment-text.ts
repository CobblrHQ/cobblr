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

import ts from "typescript";
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

/** Does any real content come BEFORE this text, inside the same parent?
 *
 *  This is the whole rule, because `//` in JSX children is usually deliberate
 *  here: section headings are written `// what's here` and styled mono, and
 *  there are ~75 of them. A heading always LEADS its parent - it is the first
 *  thing in the div, and any element after it is the count badge
 *  (`// {g.key} <span>({n})</span>`).
 *
 *  A leaked code comment has the opposite shape. It was written to describe the
 *  markup around it, so it lands AFTER something, which is exactly where it
 *  renders: in the middle of a control. So "something precedes it" separates
 *  the two cleanly, with no list of exceptions to keep. */
function followsContent(text: ts.JsxText): boolean {
  const parent = text.parent;
  if (!parent || !("children" in parent)) return false;
  const children = (parent as ts.JsxElement | ts.JsxFragment).children;
  const i = children.indexOf(text);
  if (i < 0) return false;
  // An EXPRESSION counts, not just an element. The comment that shipped sat
  // after a `{cond ? <img/> : <Thumb/>}` ternary, so an element-only test read
  // it as leading and let it through.
  return children.slice(0, i).some((c) => !ts.isJsxText(c));
}

const violations: Array<{ file: string; line: number; text: string }> = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("//")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && followsContent(node)) {
        for (const [i, raw] of node.text.split("\n").entries()) {
          const t = raw.trim();
          // A line of rendered text that STARTS with `//` is someone writing a
          // comment. `//` inside a sentence is prose (a URL, a ratio) and is
          // left alone.
          if (!t.startsWith("//")) continue;
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({ file: relative(ROOT, file), line: line + i + 1, text: t.slice(0, 72) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:jsx-comment-text - a `//` comment in JSX children renders as visible text:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error("Wrap it: {/* ... */}\n");
  process.exit(1);
}

console.log("lint:jsx-comment-text ✓ no `//` comments sitting in JSX children.");
