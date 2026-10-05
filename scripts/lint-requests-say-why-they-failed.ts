#!/usr/bin/env tsx
// A request the app makes that fails is never silently swallowed: a catch that
// shows nothing must say `quiet:` and why saying nothing is right.
//
// THE BUG THIS PREVENTS. Install bundle and Save feature changes failed with
// nothing on screen (#4145, 2026-09-29): the person could not tell a failure
// from nothing happening. lint:mutations-say-why-they-failed holds every
// useMutation to that; this holds the other door, a plain `try { await
// api.x() } catch {}`, which it never saw.
//
// THE RULE. In what renders (web/src, packages/platform-web/src, a module's
// src/ui), a `catch` whose `try` makes a request (`api.<x>(…)`, `fetch(…)`,
// `http(…)`) and whose block does nothing a person can see (empty, only
// comments, only console.*) must say `quiet: <why>` in that block: a bonus
// step, a cleanup, a background read with a fallback. Anything else in the
// block (a toast, a status, an inline message, a fallback value, a rethrow)
// passes: it is the author's answer.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A catch that assigns a
// fallback (`base = null`, `setStatus({ kind: "unavailable" })`) is a
// decision, not silence, and passes; only a block nobody can ever see
// anything from is asked for a reason. A call inside a function nested in the
// `try` does not count: that function's errors are not this catch's.
//
// PROVEN RED on 34 catches when it landed. Ten were writes a person asked for
// and now say their failure (Resend verification, a cover photo, a refresh,
// a bulk move or discard, a label, a catalog match, a backup list, a scanned
// nesting that claimed it happened); the rest say why quiet is right.
//
//   npx tsx scripts/lint-requests-say-why-they-failed.ts   (pnpm lint requests-say-why-they-failed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Only what renders: every file under web/src and platform-web, and a
 *  module's ui folder. */
const inScope = (file: string) => !file.startsWith("modules/") || /\/src\/ui\//.test(file);

const isRequest = (n: ts.CallExpression): boolean => {
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text === "fetch" || e.text === "http";
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "api";
};

function makesRequest(block: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && isRequest(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(block, visit);
  return found;
}

/** Nothing a person can see: no statements, or only console.* calls. */
function silent(block: ts.Block): boolean {
  return block.statements.every(
    (st) =>
      ts.isExpressionStatement(st) &&
      ts.isCallExpression(st.expression) &&
      ts.isPropertyAccessExpression(st.expression.expression) &&
      ts.isIdentifier(st.expression.expression.expression) &&
      st.expression.expression.expression.text === "console",
  );
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isTryStatement(n) && n.catchClause && makesRequest(n.tryBlock) && silent(n.catchClause.block)) {
      if (!/quiet:\s*\S/.test(n.catchClause.block.getFullText(sf))) {
        out.push({ file, line: line(n.catchClause), what: "a failed request is caught and nothing is said; say it, or write // quiet: <why>" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (inScope(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:requests-say-why-they-failed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Say the failure (toast.error, an inline message, a status), or write // quiet: <why> in the catch.");
  process.exit(1);
}
console.log(`lint:requests-say-why-they-failed OK`);
