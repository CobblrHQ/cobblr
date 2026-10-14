#!/usr/bin/env tsx
// An api test in a file that signs up a workspace never passes a per-test
// timeout below FRESH_ORG_BUDGET_MS, the signup helper's own worst case; the
// budget comes from the helper, not a stopwatch.
//
// THE BUG THIS PREVENTS. api/tests/attention.test.ts timed out at 30 s on
// both attempts in the post-merge gate on main and blocked a deploy (#2867).
// Its header already recorded three earlier flakes of the same shape. The
// helper takes a pooled workspace when there is one, but a full suite empties
// the pool and the fallback is a CREATE DATABASE behind the template lock
// plus every module enabled in waves: 5 to 45 s on a loaded runner. The
// suite's global testTimeout is 60 s for that reason; the file overrode it
// with 30_000, a number someone once measured on a quiet box.
//
// THE RULE. In api/tests/*.test.ts, a file that imports signupFreshOrg from
// ./helpers may not close an it()/test() with a numeric timeout smaller than
// FRESH_ORG_BUDGET_MS (read from api/tests/helpers.ts, so the two cannot
// drift). Write the constant instead: `}, FRESH_ORG_BUDGET_MS);`. A test
// that genuinely wants a tighter clock on a body that does not sign up says
// so on the closing line: `}, 5_000); // budget: <why the signup is elsewhere>`.
//
// PROVEN RED on attention.test.ts (two 30_000), scan-eval-capture.test.ts
// (30000) and undo-at-once-voids-the-purchase.test.ts (20_000) as they were;
// green once each closed with the constant.
//
// AND A RESTORE IS A SECOND WORKSPACE (#5539). A test whose own body signs up
// a workspace and restores a backup into it does two workspaces' worth of
// work: the signup, then every table recreated and refilled. Closed with one
// signup's FRESH_ORG_BUDGET_MS, the secret-backup test timed out at 60 s on a
// loaded runner three days running. Such a body closes with at least
// FRESH_ORG_BUDGET_MS * 2 (worn() on top is fine), as the vault restore test
// already did. Proven red on that test as it was.
//
// A parity check also waits for the pooled workspace's heals and inspects
// both shapes. Those stages and fresh signup need three separate budgets,
// worn at load even when the quiet budget is a named constant.
//
//   npx tsx scripts/lint-test-budget-covers-signup.ts   (pnpm run lint test-budget-covers-signup)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];
const HELPERS = "api/tests/helpers.ts";
const BUDGET = (() => {
  const m = readFileSync(HELPERS, "utf8").match(/export const FRESH_ORG_BUDGET_MS\s*=\s*([0-9_]+)/);
  if (!m) throw new Error(`${HELPERS} no longer exports FRESH_ORG_BUDGET_MS; this lint reads the budget from there`);
  return Number(m[1]!.replace(/_/g, ""));
})();
/** The closing of an it()/test() body with a numeric timeout: `}, 30_000);` */
const CLOSE_WITH_BUDGET = /^\s*\}\s*,\s*([0-9][0-9_]*)\s*\)\s*;/;

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
    else if (/\.test\.ts$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
/** The opening of an it()/test() body. */
const OPEN_TEST = /^\s*(?:it|test)(?:\.\w+)?\(/;
/** The closing of an it()/test() body, whatever its budget expression. */
const CLOSE_ANY = /^\s*\}\s*,\s*(.+?)\s*\)\s*;/;
const SIGNS_UP = /\bsignup(?:FreshOrg|BlankOrg)\s*\(/;
const RESTORES = /\/backup\/restore\b/;

/** A budget expression that covers the requested number of stages. */
function coversWorkspaces(expr: string, count: number): boolean {
  const times = expr.match(/FRESH_ORG_BUDGET_MS\s*\*\s*([0-9.]+)/);
  if (times) return Number(times[1]) >= count;
  const n = expr.match(/^(?:worn\()?([0-9][0-9_]*)\)?$/);
  return !!n && Number(n[1]!.replace(/_/g, "")) >= count * BUDGET;
}

/** Bodies that sign up a workspace and restore into it close with two
 *  workspaces' budget. */
function checkRestores(file: string, lines: string[]): Violation[] {
  const out: Violation[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (OPEN_TEST.test(line)) start = i;
    const close = start >= 0 ? line.match(CLOSE_ANY) : null;
    if (!close) continue;
    const body = lines.slice(start, i + 1).join("\n");
    start = -1;
    if (!SIGNS_UP.test(body) || !RESTORES.test(body)) continue;
    if (coversWorkspaces(close[1]!, 2) || /\/\/ budget: \S/.test(line)) continue;
    out.push({
      file,
      line: i + 1,
      what: `a test that signs up a workspace and restores a backup into it closes with ${close[1]}, one workspace's budget for two workspaces' work; close with worn(FRESH_ORG_BUDGET_MS * 2), or say why: // budget: <reason>`,
    });
  }
  return out;
}

/** Heal, signup and shape inspection have separate budgets; a named quiet
 *  constant does not wear the enclosing test's clock at the runner's load. */
function checkHealedSignup(file: string, src: string): Violation[] {
  if (!src.includes("run-all-sweeps") || !SIGNS_UP.test(src)) return [];
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /^(?:it|test)(?:\.\w+)*$/.test(node.expression.getText(tree))) {
      const body = node.arguments[1];
      const budget = node.arguments[2];
      if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))
        && body.getText(tree).includes("run-all-sweeps") && SIGNS_UP.test(body.getText(tree))
        && /\bshapeOf\b|workspace-shape/.test(body.getText(tree))) {
        const expr = budget?.getText(tree) ?? "the default timeout";
        if (!/^worn\(/.test(expr) || !coversWorkspaces(expr, 3)) out.push({
          file,
          line: tree.getLineAndCharacterOfPosition((budget ?? node).getStart(tree)).line + 1,
          what: `a test that waits for all heals, signs up and inspects workspace shape needs worn(FRESH_ORG_BUDGET_MS * 3), separate load-scaled budgets for those stages; found ${expr}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

/** A fresh workspace and a declared read deadline are separate stages. */
function checkDeclaredReadBudgets(file: string, src: string): Violation[] {
  if (!src.includes("expectNeverTorn") || !SIGNS_UP.test(src)) return [];
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const globals = new Map<string, ts.Expression>();
  const bind = (statement: ts.Statement, values: Map<string, ts.Expression>) => {
    if (!ts.isVariableStatement(statement)) return;
    for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) values.set(d.name.text, d.initializer);
    }
  };
  tree.statements.forEach((statement) => bind(statement, globals));
  const valueOf = (expr: ts.Expression, values: Map<string, ts.Expression>, seen = new Set<string>()): number | undefined => {
    if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
    if (ts.isParenthesizedExpression(expr)) return valueOf(expr.expression, values, seen);
    if (ts.isCallExpression(expr) && expr.expression.getText(tree) === "worn" && expr.arguments[0]) return valueOf(expr.arguments[0], values, seen);
    if (ts.isIdentifier(expr)) {
      if (expr.text === "FRESH_ORG_BUDGET_MS") return BUDGET;
      const next = values.get(expr.text);
      if (!next || seen.has(expr.text)) return undefined;
      return valueOf(next, values, new Set([...seen, expr.text]));
    }
    if (ts.isBinaryExpression(expr)) {
      const a = valueOf(expr.left, values, seen);
      const b = valueOf(expr.right, values, seen);
      if (a === undefined || b === undefined) return undefined;
      if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
      if (expr.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
    }
    return undefined;
  };
  const out: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /^(?:it|test)(?:\.\w+)*$/.test(node.expression.getText(tree))) {
      const body = node.arguments[1];
      if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) && SIGNS_UP.test(body.getText(tree))) {
        const values = new Map(globals);
        if (ts.isBlock(body.body)) body.body.statements.forEach((statement) => bind(statement, values));
        let readBudget = 0;
        const reads = (child: ts.Node): void => {
          if (ts.isCallExpression(child) && child.expression.getText(tree) === "expectNeverTorn") {
            const options = child.arguments[0];
            if (options && ts.isObjectLiteralExpression(options)) {
              for (const property of options.properties) {
                if (ts.isPropertyAssignment(property) && property.name.getText(tree) === "timeoutMs") {
                  const ms = valueOf(property.initializer, values);
                  if (ms !== undefined) readBudget = Math.max(readBudget, ms);
                }
              }
            }
          }
          ts.forEachChild(child, reads);
        };
        reads(body.body);
        const budget = node.arguments[2];
        const total = budget ? valueOf(budget, values) : BUDGET;
        if (readBudget > 0 && (total === undefined || total < BUDGET + readBudget)) out.push({
          file,
          line: tree.getLineAndCharacterOfPosition((budget ?? node).getStart(tree)).line + 1,
          what: `workspace setup (${BUDGET} ms) and a declared read (${readBudget} ms) need separate budgets; ${budget?.getText(tree) ?? "the default timeout"} cannot cover both. Add the read budget to FRESH_ORG_BUDGET_MS, then wear the total at load`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

export function check(file: string, src: string): Violation[] {
  const lines = src.split("\n");
  const out: Violation[] = [...checkRestores(file, lines), ...checkHealedSignup(file, src), ...checkDeclaredReadBudgets(file, src)];
  if (!/\bsignupFreshOrg\b/.test(src)) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(CLOSE_WITH_BUDGET);
    if (!m) continue;
    const ms = Number(m[1]!.replace(/_/g, ""));
    if (ms >= BUDGET) continue;
    if (/\/\/ budget: \S/.test(line)) continue;
    out.push({
      file,
      line: i + 1,
      what: `a per-test budget of ${ms} ms in a file that signs up a workspace, below the helper's worst case (${BUDGET} ms); close with FRESH_ORG_BUDGET_MS from ./helpers, or say why the clock is tighter: // budget: <reason>`,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

  if (violations.length) {
    console.error(`lint:test-budget-covers-signup - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
    process.exit(1);
  }
  console.log(`lint:test-budget-covers-signup OK`);
}
