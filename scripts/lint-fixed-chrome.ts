#!/usr/bin/env tsx
// Chrome that floats over the page is a FloatingChrome, an OverlayLayer, a
// PopoverLayer or a BackdropLayer from platform-web, never a bare fixed
// utility or position fixed of its own.
//
// THE BUG THIS PREVENTS. Thirty-two files spelled position fixed by hand and
// four of them yielded to an open overlay. The sandbox strip painted over the
// camera's shutter on a phone; before it the feedback bubble sat on a scan
// card's Confirm and the Live pill on Ask Cobb's send button. Each was fixed
// pairwise: this piece reads that piece's height, the next piece reads nothing
// (#3012, #3016, 2026-09-14). The class recurs because `fixed` is one word and
// every author has a good reason for their one piece.
//
// THE RULE. Outside packages/platform-web, a `fixed` class token (any variant
// prefix: md:fixed, max-md:fixed) in a class list, a `position: "fixed"` style
// value, a `.style.position = "fixed"` assignment, or `position: fixed` in a
// stylesheet, is a violation. A class list is a string literal or template
// piece that sits in a className/class attribute or a class-joining call
// (cn, clsx, classNames, cx, twMerge), or that carries another layout token
// beside the word (z-, inset-, top-, bottom-, left-, right-, hidden, flex, and
// so on); a sentence that happens to say "fixed" is not one.
//
// What passes: <FloatingChrome anchor="top|bottom|corner"> for a bar or a pill
// (it carries the overlay flag by default, joins the bottom dock, portals to
// body); <OverlayLayer> for a full-screen surface (it raises the flag every
// yielding piece hides on); <PopoverLayer> for a menu placed by coordinates;
// <BackdropLayer> for a dim or a ring under a dialog; Modal and SidePanel,
// which are those layers already.
//
// A genuine exception is a FILE named in ALLOW with its reason: a piece that
// is itself the layer the others yield to and cannot import the primitive.
// The list is not a baseline; it does not grow for convenience.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-fixed-chrome.ts   (pnpm run lint:fixed-chrome)
//   npx tsx scripts/lint-fixed-chrome.ts --root <dir>   judge another checkout
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Where the rule bites: every UI tree but the one that owns the primitive. */
const ROOTS = ["web/src", "modules", "ops-console/src", "packages"];
const OWNER = "packages/platform-web";

/** Files that ARE the layer: each names why it may spell fixed itself. */
const ALLOW: Record<string, string> = {
  "web/src/components/SidePanel.tsx": "the right-side panel is an overlay layer of its own and raises the flag",
  "web/src/pages/ScanCameraPage.tsx": "the camera is a full-screen overlay layer: viewfinder, shutter and its own controls",
  "web/src/lib/outfit-planner-app.ts": "a drag ghost inside an app-player script that runs in the app's own frame, not the shell",
};

/** Beside the word `fixed`, any of these makes a literal a class list. */
const LAYOUT_TOKEN = /(^|\s)(?:[a-z-]+:)*(?:-?z-|inset-|top-|bottom-|left-|right-|hidden|block|flex|grid|w-|h-|p[xytrbl]?-|m[xytrbl]?-|-?translate-|pointer-events-|overflow-|rounded|bg-|shadow)/;
const FIXED_TOKEN = /(^|\s)(?:[a-z-]+:)*!?fixed(\s|$)/;
const CLASS_CALL = /^(cn|clsx|classNames|cx|twMerge)$/;

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 ? (process.argv[rootArg + 1] ?? ".") : ".";

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
    else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** A sentence or a stylesheet, which share words with a class list (hidden,
 *  flex, block) but not its shape: no punctuation, no articles. */
const NOT_A_CLASS_LIST = /[;{}]|,\s|\.\s|\s(a|an|the|is|was|to|of|and|or)\s/;

/** Is this literal a class list? Its own tokens say so, or where it sits does. */
function isClassList(node: ts.Node, text: string): boolean {
  if (NOT_A_CLASS_LIST.test(text)) return false;
  if (LAYOUT_TOKEN.test(text)) return true;
  let p: ts.Node | undefined = node.parent;
  for (let i = 0; i < 6 && p; i++, p = p.parent) {
    if (ts.isJsxAttribute(p)) return /^(className|class)$/.test(p.name.getText());
    if (ts.isCallExpression(p)) return CLASS_CALL.test(p.expression.getText());
  }
  return false;
}

function checkSource(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      if (FIXED_TOKEN.test(text) && isClassList(node, text)) {
        out.push({ file, line: at(node), what: "a bare `fixed` class: " + text.trim().slice(0, 80) });
      }
      // CSS in a string (a stylesheet an app script injects, a <style> body).
      if (/position\s*:\s*fixed\b/.test(text)) {
        out.push({ file, line: at(node), what: "position: fixed in a stylesheet string" });
      }
    }
    // { position: "fixed" } in a style object.
    if (ts.isPropertyAssignment(node) && /^['"]?position['"]?$/.test(node.name.getText()) && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) && node.initializer.text === "fixed") {
      out.push({ file, line: at(node), what: 'position: "fixed" in a style object' });
    }
    // el.style.position = "fixed"
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "position" && ts.isStringLiteral(node.right) && node.right.text === "fixed") {
      out.push({ file, line: at(node), what: 'style.position = "fixed"' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function checkCss(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = noComments.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/position\s*:\s*fixed\b/.test(lines[i] ?? "")) out.push({ file, line: i + 1, what: "position: fixed in a stylesheet" });
  }
  return out;
}

const violations: Violation[] = [];
const files = new Set<string>();
for (const root of ROOTS) {
  for (const abs of walk(join(ROOT, root))) {
    const file = relative(ROOT, abs);
    if (file.startsWith(OWNER)) continue;
    if (file in ALLOW) continue;
    const src = readFileSync(abs, "utf8");
    if (!src.includes("fixed")) continue;
    const found = file.endsWith(".css") ? checkCss(file, src) : checkSource(file, src);
    for (const v of found) files.add(v.file);
    violations.push(...found);
  }
}

if (violations.length) {
  console.error(`lint:fixed-chrome - ${violations.length} violation(s) in ${files.size} file(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "\nRender the piece as <FloatingChrome anchor=...> (a bar or a pill), <OverlayLayer> (a\n" +
      "full-screen surface, which raises the overlay flag), <PopoverLayer> (a menu placed by\n" +
      "coordinates) or <BackdropLayer> (a dim or a ring under a dialog), all from\n" +
      "@cobblr/platform-web. A layer that genuinely cannot be one of those is named in ALLOW\n" +
      "in scripts/lint-fixed-chrome.ts with its reason.",
  );
  process.exit(1);
}
console.log(`lint:fixed-chrome OK`);
