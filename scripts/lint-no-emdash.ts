// No em dashes in USER-FACING text. The em dash reads as machine-written prose
// (the standing "plain human voice" rule), so it must not reach the UI. This
// is scoped on purpose:
//   - CODE COMMENTS are exempt — users never see them, and the house comment
//     style leans on em dashes heavily; the AST simply never visits comments.
//   - A LONE "—" is a legitimate empty-value placeholder (`return "—"`), not
//     prose, so a dash-only string is allowed. A violation needs a real word
//     next to the dash.
// It catches em dashes (U+2014) and horizontal bars (U+2015) in: JSX text, the
// user-facing JSX attributes below, toast.*() message args, and COPY PROPERTIES
// in object literals, everywhere it looks; and in UI CODE (web/src,
// packages/platform-web/src, a module's ui/) in EVERY string a person could
// be shown. The narrower shapes let 579 dashes through across 130 UI files
// (2026-09-30): an error set with setError("… — …"), a sentence built in a
// helper and returned, a confirm message assembled in a variable. In UI code a
// string with words and a dash in it is copy unless it goes to the console. Fix by rewording (a spaced hyphen, a comma, a colon, or
// two sentences — whatever reads plain).
//
// Why copy properties (added 2026-07-30): much of Cobblr's user-facing text is
// DATA, not JSX. The settings registry, the featured-bundle catalog, label
// sizes and every module manifest are object literals whose label /
// description / blurb strings are rendered into the UI later, so the AST never
// saw them as user-facing and they were exempt by accident. The configuration
// revamp shipped a section blurb reading "What we run for you — your plan…"
// straight past a green lint, which is how the gap surfaced.
//
// That exposed real pre-existing debt, which was baselined for a while and
// then swept to zero (2026-09-30), when the baseline went: there is no list of
// allowed ones any more, so every hit fails.

import ts from "typescript";
import { stripComments } from "./lib/source-scan.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = /[—―]/;
const UI_ATTRS = new Set(["title", "placeholder", "alt", "aria-label", "label"]);
const TOAST = /^(toast\.(success|error|info|warning|action)|usePageTitle)$/;

/** Where every string is read as copy. */
function isUiFile(rel: string): boolean {
  return rel.startsWith("web/src/") || rel.startsWith("packages/platform-web/src/") || /^modules\/[^/]+\/src\/ui\//.test(rel);
}

/** Strings in UI code that are not for a person: console output, and text
 *  written for a model rather than a reader. */
const NOT_COPY_CALL = /^console\.|^debug$/;
const MODEL_PROPS = new Set(["ai_notes", "prompt", "system", "instructions"]);

/** Object-literal properties that hold user-facing COPY. Deliberately narrow:
 *  `id`, `route` or `key` can hold anything, but these are words a person
 *  reads on screen. */
const COPY_PROPS = new Set([
  "label",
  "description",
  "desc",
  "blurb",
  "hint",
  "help",
  "helpText",
  "title",
  "subtitle",
  "placeholder",
  "summary",
  "displayName",
  "displayNamePlural",
  "emptyText",
  // Words a user reads as a SENTENCE, not a caption. `reply` is literally what
  // the assistant says back; `message` and `error` surface in toasts; a bundle's
  // `changelog` is read in the update prompt. All were exempt on the first pass
  // because the list started from caption-shaped names, and the assistant's
  // answers alone carried 26 em dashes nobody could see.
  "reply",
  "message",
  "error",
  "reason",
  "note",
  "changelog",
  "content",
  "text",
  "body",
  "detail",
  "rationale",
  "why",
]);
// NOT copy, deliberately: `ai_notes` and prompt templates are instructions to a
// MODEL, not prose for a person, and an em dash there costs nothing.

/** Prose = a dash with an actual word somewhere in the string. A dash-only value
 *  ("—", " — ") is an empty-state placeholder, not prose, and is allowed. */
function isProseDash(s: string): boolean {
  // Code a page emits is not shown: the comments in an embedded app's
  // stylesheet and script (a string that carries a <style> or <script>, read
  // by the one comment scanner), and a quoted lone dash, which is the
  // empty-value placeholder again, one level of quoting in ("—").
  if (/<(style|script)\b/i.test(s)) s = stripComments(s);
  s = s.replace(/(["'])[—―]\1/g, "");
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
  /** The words in a node, whether or not it interpolates.
   *
   *  A template with a hole in it is still copy: `title={`Cobb is talking about
   *  ${label} — click to stop`}` reads to a person exactly like the same
   *  sentence in quotes, and used to sail past this lint because only literals
   *  were read. The interpolations are dropped and the surrounding text is
   *  checked, which is where a dash can actually be. */
  const strVal = (n: ts.Node): string | null => {
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      return n.head.text + n.templateSpans.map((sp) => sp.literal.text).join(" ");
    }
    // A ternary of copy is still copy: `x ? \`a — b\` : "c"`.
    if (ts.isConditionalExpression(n)) {
      return [strVal(n.whenTrue), strVal(n.whenFalse)].filter(Boolean).join(" ");
    }
    return null;
  };

  const ui = isUiFile(relative(ROOT, path));
  /** Inside a console call, or a model's instructions: not copy. */
  const notCopy = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && NOT_COPY_CALL.test(calleeText(p))) return true;
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && MODEL_PROPS.has(p.name.text)) return true;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    // 0) UI code: every string with words and a dash is copy.
    if (ui && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
      const lit = strVal(node);
      if (lit && isProseDash(lit) && !notCopy(node)) add(node, lit);
      if (ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
      return;
    }
    // 1) JSX text between tags — the most common user-facing surface.
    if (ts.isJsxText(node)) {
      if (isProseDash(node.text)) add(node, node.text);
    }
    // 2) User-facing JSX attribute string values (title=, placeholder=, …).
    else if (!ui && ts.isJsxAttribute(node) && node.initializer) {
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
    else if (!ui && ts.isCallExpression(node) && TOAST.test(calleeText(node))) {
      for (const arg of node.arguments) {
        const lit = strVal(arg);
        if (lit && isProseDash(lit)) add(arg, lit);
      }
    }
    // 4) Copy properties in object literals — the registries and manifests
    //    whose strings ARE the UI text, just one render away.
    else if (!ui && ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : null;
      if (name && COPY_PROPS.has(name)) {
        const lit = strVal(node.initializer);
        if (lit && isProseDash(lit)) add(node, lit);
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

for (const root of ["web/src", "packages/platform-web/src", "modules"]) {
  try {
    walk(join(ROOT, root));
  } catch {
    /* absent root — skip */
  }
}

if (violations.length) {
  console.error(
    `Em dash in user-facing text (${violations.length}): reword to plain prose (a comma, a colon, or two sentences):`,
  );
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(
    `\nNote: in UI code every string with words in it is copy; elsewhere, object-literal copy properties\n` +
      `(${[...COPY_PROPS].slice(0, 5).join(", ")}, …) count, since a registry or manifest string is UI text one render away.`,
  );
  process.exit(1);
}
console.log("lint:no-emdash: no em dashes in user-facing text.");
