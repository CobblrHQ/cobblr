#!/usr/bin/env tsx
// Headers merged from a spread are spelled the way the spread spells them: a second spelling of the same header is joined into one value, and a joined content-type means the body is never read.
//
// THE BUG THIS PREVENTS. The configuration nightly walk spread the runner's
// headers, which say `content-type`, and added `Content-Type` beside them.
// fetch keeps both and joins them: "application/json, application/json". The
// api's JSON parser does not recognise that, reads no body, and every seed
// POST answered 400 "Bad field def" with entity_kind undefined, which read
// like a broken field-def contract (#4650, 2026-10-03).
//
// THE RULE. An object literal that spreads something (`{ ...H, ... }`) never
// adds a header name with a capital letter, directly or inside another spread
// in the same literal (`...(body ? { "Content-Type": ... } : {})`). Spell it
// lowercase, which is how this repo's runners and helpers spell headers, so
// the later key REPLACES the spread one instead of joining it. No opt-out: a
// lowercase name is always the fix.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a literal with a
// spread. `{ "Content-Type": "application/json" }` alone is one spelling and
// is fine (dozens of e2e files write that); the join needs two sources. And
// only header-shaped names (Content-Type, Authorization, Accept, Cookie,
// X-...), so a capitalised key in a data object that happens to spread is
// left alone. And only a spread that can bring keys from elsewhere: `{
// "Content-Type": ..., ...(token ? { Authorization: ... } : {}) }` is all one
// author's spelling, and e2e/approval-flow.mjs writes exactly that.
//
//   npx tsx scripts/lint-header-one-spelling.ts   (pnpm lint header-one-spelling)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOTS = ["e2e", "scripts"];
const HEADER = /^(content-type|content-length|authorization|accept|accept-language|cookie|user-agent|x-[a-z0-9-]+)$/i;

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
    else if (/\.(mjs|js|ts)$/.test(name)) yield p;
  }
}

const keyText = (n: ts.PropertyName): string | null => (ts.isStringLiteral(n) || ts.isIdentifier(n) ? n.text : null);

/** Every key this literal sets itself, or through an object literal written
 *  inside one of its spreads. */
function ownKeys(lit: ts.ObjectLiteralExpression): Array<{ name: string; node: ts.Node }> {
  const out: Array<{ name: string; node: ts.Node }> = [];
  for (const p of lit.properties) {
    if (ts.isPropertyAssignment(p)) {
      const k = keyText(p.name);
      if (k) out.push({ name: k, node: p });
    } else if (ts.isSpreadAssignment(p)) {
      const inner = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n)) out.push(...ownKeys(n));
        else ts.forEachChild(n, inner);
      };
      inner(p.expression);
    }
  }
  return out;
}

/** Can this spread bring keys written somewhere else (a variable, a
 *  parameter, a call)? A conditional between literals cannot. */
function foreign(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isObjectLiteralExpression(e)) return false;
  if (ts.isConditionalExpression(e)) return foreign(e.whenTrue) || foreign(e.whenFalse);
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return foreign(e.left) || foreign(e.right);
  return true;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!src.includes("...")) return out;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some((p) => ts.isSpreadAssignment(p) && foreign(p.expression))) {
      for (const k of ownKeys(node)) {
        if (HEADER.test(k.name) && k.name !== k.name.toLowerCase()) {
          const { line } = sf.getLineAndCharacterOfPosition(k.node.getStart(sf));
          out.push({ file, line: line + 1, what: `"${k.name}" beside a spread: if the spread says "${k.name.toLowerCase()}", fetch joins the two` });
        }
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
  console.error("lint:header-one-spelling - a header spelled differently from the spread beside it is sent twice and joined:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.what}\n`);
  console.error("Spell the header lowercase, so it replaces the spread's instead of joining it.\n");
  process.exit(1);
}
console.log("lint:header-one-spelling ✓ no header added beside a spread under a second spelling.");
