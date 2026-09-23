#!/usr/bin/env tsx
// A per-test timeout, on a test, a describe or a testing-library wait, is worn at the box's load through worn(ms) from scripts/lib/load-factor.mjs, never a bare number, because the config wears only the default and a literal replaces it with a quiet-box budget.
//
// THE BUG THIS PREVENTS. merge-pr.test.ts's 409 retry case timed out at a literal 60 s on a runner at load 48 on twelve cores while the script did nothing slow; two single steps stalled 52-58 s under IO pressure (#3479, 2026-09-22).
//
// THE RULE. A timeout handed to one test is a wall-clock budget, and the
// vitest configs wear only the DEFAULT budget at the box's load
// (scripts/lib/load-factor.mjs, #3150). So in a test file:
//   - it / test / describe (and .skip/.only/.concurrent/.each forms): a
//     numeric third argument, or an options object whose `timeout` is a
//     number, fails;
//   - waitFor / vi.waitFor / waitForElementToBeRemoved / findBy* / findAllBy*
//     / expect.poll: an options object whose `timeout` is a number fails.
// `timeout: worn(60_000)` passes, and so does any other expression (a named
// constant is somebody's decision, visible at its definition). Opt out on the
// line or the one above with `// TIMEOUT-UNWORN: <why>`, for a budget that is
// itself the thing under test.
//
// Proven red on the tree it was written against: the two merge-pr.test.ts
// cases from the incident and every other literal per-test timeout.
//
//   npx tsx scripts/lint-test-timeout-worn.ts   (pnpm run lint:test-timeout-worn)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests", "modules", "packages", "scripts", "web/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
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
    else if (/\.test\.[cm]?[tj]sx?$/.test(name)) yield p;
  }
}

const TEST_CALLS = new Set(["it", "test", "describe", "bench"]);
const WAIT_CALLS = /^(waitFor|waitForElementToBeRemoved|find(All)?By\w+|poll)$/;
const OPT_OUT = /TIMEOUT-UNWORN:\s*\S/;

/** A bare number: 60_000, 2 * 60_000, -1. Anything with a call or a name in it is not. */
function isBareNumber(e: ts.Expression): boolean {
  if (ts.isNumericLiteral(e)) return true;
  if (ts.isParenthesizedExpression(e)) return isBareNumber(e.expression);
  if (ts.isPrefixUnaryExpression(e)) return isBareNumber(e.operand);
  if (ts.isBinaryExpression(e)) return isBareNumber(e.left) && isBareNumber(e.right);
  return false;
}

/** The name a call is made through: `it`, `it.skip`, `it.each(t)` -> "it"; `screen.findByText` -> "findByText". */
function calleeName(e: ts.Expression): { base: string | null; last: string | null } {
  let cur: ts.Expression = e;
  let last: string | null = null;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      last ??= cur.name.text;
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression;
    } else break;
  }
  const base = ts.isIdentifier(cur) ? cur.text : null;
  return { base, last: last ?? base };
}

function numericTimeout(arg: ts.Expression): ts.Node | null {
  if (!ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === "timeout" && isBareNumber(p.initializer)) return p;
  }
  return null;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!/timeout|\d[\d_]{3,}/.test(src)) return out;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split("\n");
  const flag = (node: ts.Node, what: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (OPT_OUT.test(lines[line] ?? "") || OPT_OUT.test(lines[line - 1] ?? "")) return;
    out.push({ file, line: line + 1, what });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const { base, last } = calleeName(n.expression);
      if (base && TEST_CALLS.has(base)) {
        n.arguments.forEach((a, i) => {
          if (i >= 1 && isBareNumber(a)) flag(a, `${base}(): a bare ${a.getText(sf)} ms timeout, not worn at the box's load`);
          const t = numericTimeout(a);
          if (t) flag(t, `${base}(): ${t.getText(sf)} is a quiet-box budget, not worn at the box's load`);
        });
      } else if (last && WAIT_CALLS.test(last)) {
        for (const a of n.arguments) {
          const t = numericTimeout(a);
          if (t) flag(t, `${last}(): ${t.getText(sf)} is a quiet-box budget, not worn at the box's load`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-timeout-worn - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("{ timeout: worn(60_000) } with import { worn } from scripts/lib/load-factor.mjs");
  process.exit(1);
}
console.log(`lint:test-timeout-worn OK`);
