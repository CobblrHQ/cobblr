// An actions bar must be allowed to SHRINK, or the title pays for it.
//
// EntityActionsBar is `flex-wrap`, so it can always fold onto a second line and
// take the space it actually needs. `shrink-0` on the element around it removes
// that option: the bar holds its full intrinsic width, and in a flex row the
// only sibling left to give up space is the heading beside it.
//
// What that looks like: a location called "Rack 1" wrapped to two lines on a
// wide desktop because five action buttons sat beside it, and at narrower
// widths the Cobb button rendered ON TOP of the word it had squeezed
// (2026-08-23). The action set is not fixed either - a bundle can register
// more - so any header that wins this negotiation today loses it later.
//
// The fix is one of:
//   - give the bar its own full-width row: `order-last w-full`
//   - or just drop `shrink-0` and let it wrap in place
//
// Scoped to the wrapper element ONLY. `shrink-0` elsewhere in a header (on a
// thumbnail, on a back link) is right and is not touched.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "modules", "packages"];

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

/** The literal className of a JSX element, or "" if it is computed. */
function classNameOf(open: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  for (const attr of open.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "className") continue;
    const init = attr.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    // A template literal still carries its static words, which is where the
    // layout classes live.
    if (init && ts.isJsxExpression(init) && init.expression) {
      return init.expression.getText();
    }
  }
  return "";
}

function containsActionsBar(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      if (n.tagName.getText() === "EntityActionsBar") { found = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

const violations: Array<{ file: string; line: number; text: string }> = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("EntityActionsBar") || !src.includes("shrink-0")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node)) {
        const cls = classNameOf(node.openingElement);
        // No carve-out for `w-full`. The first version exempted it, and that
        // exemption is exactly what let the bug through: the class read
        // `w-full shrink-0 ... sm:w-auto`, so it owned its own row on a phone
        // and went back to fighting the title at every width above that. A bar
        // that has its own row does not need `shrink-0` to keep it, so the
        // class is never load-bearing here and is always worth removing.
        const pinned = /(^|[\s"'`])shrink-0([\s"'`]|$)/.test(cls);
        if (pinned && containsActionsBar(node)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({ file: relative(ROOT, file), line: line + 1, text: cls.slice(0, 90) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:actions-bar-shrink - an actions bar pinned at full width beside a title:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error(
    "The bar wraps on its own; `shrink-0` stops it, so the heading beside it\n" +
      "absorbs the shortfall and wraps instead. Give the bar its own row\n" +
      "(`order-last w-full`) or drop `shrink-0` and let it wrap in place.\n",
  );
  process.exit(1);
}

console.log("lint:actions-bar-shrink ✓ no actions bar pinned against a title.");
