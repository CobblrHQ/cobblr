// No em dashes in USER-FACING text. The em dash reads as machine-written prose
// (the author's standing "plain human voice" rule), so it must not reach the UI. This
// is scoped on purpose:
//   - CODE COMMENTS are exempt — users never see them, and the house comment
//     style leans on em dashes heavily; the AST simply never visits comments.
//   - A LONE "—" is a legitimate empty-value placeholder (`return "—"`), not
//     prose, so a dash-only string is allowed. A violation needs a real word
//     next to the dash.
// It catches em dashes (U+2014) and horizontal bars (U+2015) in: JSX text, the
// user-facing JSX attributes below, and toast.*() message args. Fix by rewording
// (a spaced hyphen, a comma, a colon, or two sentences — whatever reads plain).

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = /[—―]/;
const UI_ATTRS = new Set(["title", "placeholder", "alt", "aria-label", "label"]);
const TOAST = /^(toast\.(success|error|info|warning|action)|usePageTitle)$/;

/** Prose = a dash with an actual word somewhere in the string. A dash-only value
 *  ("—", " — ") is an empty-state placeholder, not prose, and is allowed. */
function isProseDash(s: string): boolean {
  return DASH.test(s) && /[A-Za-z0-9]/.test(s);
}

function calleeText(node: ts.CallExpression): string {
  const e = node.expression;
  if (ts.isPropertyAccessExpression(e)) return `${e.expression.getText()}.${e.name.text}`;
  if (ts.isIdentifier(e)) return e.text;
  return "";
}

const violations: { file: string; line: number; text: string }[] = [];

function scanFile(path: string) {
  const src = readFileSync(path, "utf8");
  if (!DASH.test(src)) return;
  // Parse .ts as TS, not TSX: forcing TSX on a .ts file misreads `foo<T>()`
  // generics and `<Foo>x` assertions as JSX, which turns nearby COMMENT text
  // into fake JsxText and false-positives on comments (users never see those).
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const add = (node: ts.Node, raw: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    violations.push({ file: relative(ROOT, path), line: line + 1, text: raw.replace(/\s+/g, " ").trim().slice(0, 90) });
  };
  const strVal = (n: ts.Node): string | null =>
    ts.isStringLiteralLike(n) ? n.text : ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;

  const visit = (node: ts.Node) => {
    // 1) JSX text between tags — the most common user-facing surface.
    if (ts.isJsxText(node)) {
      if (isProseDash(node.text)) add(node, node.text);
    }
    // 2) User-facing JSX attribute string values (title=, placeholder=, …).
    else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText();
      if (UI_ATTRS.has(name)) {
        const lit =
          ts.isStringLiteral(node.initializer) ? node.initializer.text
          : ts.isJsxExpression(node.initializer) && node.initializer.expression
            ? strVal(node.initializer.expression)
            : null;
        if (lit && isProseDash(lit)) add(node, lit);
      }
    }
    // 3) toast.*() / usePageTitle() message arguments.
    else if (ts.isCallExpression(node) && TOAST.test(calleeText(node))) {
      for (const arg of node.arguments) {
        const lit = strVal(arg);
        if (lit && isProseDash(lit)) add(arg, lit);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__snapshots__") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) scanFile(p);
  }
}

for (const root of ["web/src", "modules"]) {
  try {
    walk(join(ROOT, root));
  } catch {
    /* absent root — skip */
  }
}

if (violations.length) {
  console.error(`Em dash in user-facing text (${violations.length}) — reword to plain prose (hyphen, comma, colon, or two sentences):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}
console.log("lint:no-emdash — no em dashes in user-facing text.");
