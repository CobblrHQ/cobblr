#!/usr/bin/env tsx
// A count guarding JSX children is compared, never left bare: {list.length && <x/>} renders a 0 on the page when the list is empty.
//
// THE BUG THIS PREVENTS. A public record page showed a stray 0 under its About
// line when it had no links (2026-10-03). The guard was
// `{(contact || frame?.links?.length) && (...)}`: with no contact and no links
// the expression is 0, and React renders a number, unlike false or null. It
// type-checks, reads as a boolean test in review, and only a screen shows it.
//
// THE RULE. A JSX child `{a && b}` fails when `a` can come out as a bare
// `.length` or `.size`: the count itself, the last operand of an `||`, either
// side of a nested `&&`, either side of a `??`. Compare it instead
// (`list.length > 0 && ...`) or make it a boolean (`!!list.length`). There is
// no opt-out: the fix is always shorter than an annotation would be.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only JSX CHILDREN. The same
// `x.length && y` in an attribute (`disabled={!rows.length && busy}`), a
// variable or an `if` is ordinary logic, and most of the repo's ~35 textual
// matches are exactly that; a 0 there is never drawn on the page. And only an
// operand that can BE the value: `a.length || fallback` returns the count only
// when it is truthy, so a count on the left of `||` is never a 0.
//
//   npx tsx scripts/lint-jsx-zero-renders.ts   (pnpm lint jsx-zero-renders)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOTS = ["web/src", "modules", "packages", "ops-console/src"];

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
    else if (name.endsWith(".tsx")) yield p;
  }
}

const COUNTS = new Set(["length", "size"]);

/** Can this expression's VALUE be a bare count, and so a 0? */
function canBeCount(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) return COUNTS.has(e.name.text);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.QuestionQuestionToken) return canBeCount(e.left) || canBeCount(e.right);
    if (op === ts.SyntaxKind.BarBarToken) return canBeCount(e.right);
  }
  return false;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!src.includes("&&")) return out;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      let e = node.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && canBeCount(e.left)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ file, line: line + 1, what: `{${e.left.getText(sf).replace(/\s+/g, " ").slice(0, 60)} && ...} renders 0 when the count is 0` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) violations.push(...check(relative(ROOT, file), readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error("lint:jsx-zero-renders - a bare count guarding JSX children draws a 0 on the page when it is 0:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.what}\n`);
  console.error("Compare it: {list.length > 0 && ...}, or {!!list.length && ...}.\n");
  process.exit(1);
}
console.log("lint:jsx-zero-renders ✓ no bare count guards JSX children.");
