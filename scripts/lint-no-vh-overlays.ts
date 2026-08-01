// A FIXED overlay must never be sized with a viewport height (h-screen,
// h-[100vh], min-h-screen, 100vh in a style). On iOS `100vh` is the LARGE
// viewport — measured as if the browser toolbars were retracted — so the
// element is TALLER than what the user can actually see and its bottom row
// (a composer, a Save button, the last list item) sits below the fold with no
// way to scroll to it. In a standalone PWA the home indicator eats it instead.
//
// This shipped twice from one copy-paste: ChatWidget's "Ask Cobb" panel and
// NotificationsBell's sidebar were the same `fixed top-0 right-0 h-screen`
// string, and Ask Cobb's message box was unreachable on a phone (the author reported
// it more than once). Both now render through web/src/components/SidePanel.tsx.
//
// The fix in every case: pin `top` AND `bottom` (inset-y-0, or
// top-[var(--app-header-bottom)] + bottom-0) so the box tracks the visible
// viewport, or use the dynamic units (dvh/svh) if you genuinely need a height.
// Non-fixed elements are untouched: `min-h-screen` on a PAGE is fine and
// common — the page scrolls, so being taller than the viewport is the point.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "packages", "modules"];
// Viewport-height sizing that does NOT track the visible viewport. dvh/svh/lvh
// are deliberately absent: they are the correct escape hatch.
const VH = /\b(h-screen|min-h-screen|max-h-screen|h-\[100vh\]|min-h-\[100vh\]|100vh)\b/;
const FIXED = /(^|\s)fixed(\s|$)/;
// A height utility carrying 100vh ANYWHERE - the panel inside a fixed
// overlay is not itself `fixed`, which is how the shared Modal kept
// max-h-[calc(100vh-4rem)] straight past the first version of this lint
// and cut its own action row off on iOS (the author, 2026-08-01). dvh is strictly
// better wherever a viewport height is wanted, so flag the unit itself.
const VH_HEIGHT = /\b(?:max-h|min-h|h)-\[[^\]]*100vh[^\]]*\]/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

type Violation = { file: string; line: number; text: string };
const violations: Violation[] = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const src = readFileSync(file, "utf8");
    // Cheap pre-filter: no viewport height anywhere means nothing to check.
    if (!VH.test(src) && !VH_HEIGHT.test(src)) continue;
    const sf = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    // Any string literal (or template chunk) that reads like a class list AND
    // carries both `fixed` and a viewport height. Keeping it to one literal
    // avoids guessing how a className was assembled while still catching the
    // shape that actually shipped.
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const t = node.text;
        if ((FIXED.test(t) && VH.test(t)) || VH_HEIGHT.test(t)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({ file: relative(ROOT, file), line: line + 1, text: t.trim().slice(0, 110) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:no-vh-overlays - a fixed overlay is sized with a viewport height:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error(
    "On iOS 100vh is the LARGE viewport, so the overlay is taller than the screen\n" +
      "and its bottom row is unreachable. Pin top AND bottom instead (inset-y-0, or\n" +
      "top-[var(--app-header-bottom)] + bottom-0), or use dvh/svh if you need a height.\n" +
      "For a right-side panel just use web/src/components/SidePanel.tsx.",
  );
  process.exit(1);
}

console.log("lint:no-vh-overlays - no fixed overlay sized with a viewport height.");
