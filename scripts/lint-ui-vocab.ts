// The install-vocabulary lint (new-user-flow.md F1). The system nouns are
// MODULE and BUNDLE (plus "category" for a named instance and "capability" for
// an operator module) - a decision made long ago and documented. What actually
// happened in the UI was drift: the same objects got re-nouned per surface
// ("tracker", "recipe", "specialisation", "starter pack"), so the offer kept
// changing name depending on which door the user walked through and no mental
// model could form. This lint keeps the retired nouns from creeping back into
// CAPTION-SHAPED text: JSX text, UI attributes, usePageTitle/toast calls, and
// caption-like object properties (label/title/headline/...).
//
// Deliberately NOT flagged:
//   - long-prose properties (blurb, description, hint, body...): the ruling
//     allows a descriptive phrase ("a bundle: fields already shaped"); it
//     retires competing NOUNS in headings, titles and buttons.
//   - "preset", "setup", "thing", "kind": real words with legitimate other
//     meanings all over the app (print presets, "Set up X", "Add another
//     thing" about an ITEM). Policing those would drown signal in noise.
//   - comments and docs (users never see comments; docs are reviewed prose).
//
// Existing hits are BASELINED (scripts/ui-vocab-baseline.json): green today,
// FAILS on any new one. Shrink the baseline, never grow it; refresh with
// --update after fixing some.

import ts from "typescript";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED = /\b(trackers?|recipes?|specialisations?|specializations?|starter packs?)\b/i;
const UI_ATTRS = new Set(["title", "placeholder", "alt", "aria-label", "label", "kicker", "hint"]);
const CALLS = /^(toast\.(success|error|info|warning|action)|usePageTitle)$/;
const CAPTION_PROPS = new Set(["label", "title", "headline", "displayName", "displayNamePlural", "placeholder", "subtitle", "emptyText"]);
const BASELINE_PATH = join(ROOT, "scripts/ui-vocab-baseline.json");

function calleeText(node: ts.CallExpression): string {
  const e = node.expression;
  if (ts.isPropertyAccessExpression(e)) return `${e.expression.getText()}.${e.name.text}`;
  if (ts.isIdentifier(e)) return e.text;
  return "";
}

const violations: { file: string; line: number; text: string }[] = [];

function scanFile(path: string) {
  const src = readFileSync(path, "utf8");
  if (!RETIRED.test(src)) return;
  // Parse .ts as TS, not TSX: forcing TSX on .ts misreads generics as JSX and
  // false-positives on comment text (the lint-no-emdash lesson).
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const add = (node: ts.Node, raw: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    violations.push({ file: relative(ROOT, path), line: line + 1, text: raw.replace(/\s+/g, " ").trim().slice(0, 90) });
  };
  const strVal = (n: ts.Node): string | null =>
    ts.isStringLiteralLike(n) ? n.text : ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (RETIRED.test(node.text)) add(node, node.text);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText();
      if (UI_ATTRS.has(name)) {
        const lit =
          ts.isStringLiteral(node.initializer) ? node.initializer.text
          : ts.isJsxExpression(node.initializer) && node.initializer.expression
            ? strVal(node.initializer.expression)
            : null;
        if (lit && RETIRED.test(lit)) add(node, lit);
      }
    } else if (ts.isCallExpression(node) && CALLS.test(calleeText(node))) {
      for (const arg of node.arguments) {
        const lit = strVal(arg);
        if (lit && RETIRED.test(lit)) add(arg, lit);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name && CAPTION_PROPS.has(name)) {
        const lit = strVal(node.initializer);
        if (lit && RETIRED.test(lit)) add(node, lit);
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

for (const root of ["web/src", "modules", "packages/platform-web/src"]) {
  try {
    walk(join(ROOT, root));
  } catch {
    /* absent root - skip */
  }
}

const key = (v: { file: string; text: string }) => `${v.file}::${v.text}`;

if (process.argv.includes("--update")) {
  const rows = violations
    .map((v) => ({ file: v.file, text: v.text }))
    .sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`lint:ui-vocab - baseline rewritten with ${rows.length} entries.`);
  process.exit(0);
}

const baseline: { file: string; text: string }[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { file: string; text: string }[])
  : [];
const known = new Set(baseline.map(key));
const fresh = violations.filter((v) => !known.has(key(v)));
const fixed = baseline.filter((b) => !violations.some((v) => key(v) === key(b)));

if (fixed.length) {
  console.log(
    `lint:ui-vocab - ${fixed.length} baselined hit(s) are gone. Run \`pnpm run lint:ui-vocab -- --update\` to shrink the baseline.`,
  );
}

if (fresh.length) {
  console.error(
    `Retired install-noun in caption-shaped UI text (${fresh.length} new). The nouns are MODULE and\n` +
      `BUNDLE (a named instance is a "category"; an operator module is a "capability") -\n` +
      `docs/design-decisions/new-user-flow.md F1:`,
  );
  for (const v of fresh) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}
console.log(`lint:ui-vocab - no NEW retired nouns in caption text (${baseline.length} baselined).`);
