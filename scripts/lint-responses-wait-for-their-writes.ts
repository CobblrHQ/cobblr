#!/usr/bin/env tsx
// A route file never starts work with a bare void call or a loose promise chain unless the line says why it may outlive the response, on a DETACHED: line.
//
// THE BUG THIS PREVENTS. Discarding a receipt's last line deleted its order in
// a `void (async () => …)()` after the answer, and filing a line claimed its
// order line with `void claimOrderLine(…)`. The discard said done while the
// order was still there, a failure in it was only logged, and discarding the
// other lines straight after filing one could find no line claimed yet and
// delete an order that held a real purchase (#5046, 2026-10-06; main went red
// on it under load).
//
// THE RULE. Inside a route handler (a function passed to router.get/post/
// put/patch/delete/all/use), these are refused:
//   - `void <expr>` where the expression makes a call (`void doIt()`,
//     `void (async () => …)()`, `void db.updateTable(…)…execute()`);
//   - a statement that is a promise chain left to run (`doIt().then(…)`,
//     `x.catch(…)` with nobody awaiting it).
// Await it, so the answer means the work is done, or say on the line (or in
// the comment directly above) why it may outlive the response:
//   // DETACHED: a notification; the request is complete without it
// A reason names what happens if it never finishes. Notifications, telemetry,
// cache warming and enrichment that a later read heals are the usual ones.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `void sql;` and the like
// (a void over a bare name, there to keep an import used) make no call and
// pass, and so does `return void res.status(…).json(…)`, the idiom for
// answering and stopping: there the call IS the response (it was 330 of a
// first cut's 412). So does a synchronous handler whose body is
// `void (async () => { … })().catch(next)`: that async function is the
// handler and writes the response itself. `platform().events.emit(…)` passes: the event bus is the platform's
// way to let work happen after a write, its handlers run on their own and
// say their own errors, and a route that emits is not promising the
// handlers' work is done. Only the handlers passed to a route registration
// are judged: a file's startup code, sweeps and workers have no response to
// outlive, and a first cut over whole route files flagged 433 places, most of
// them module start-up warming caches. A helper a handler calls is judged
// where it is passed inline, not where it is defined. A call whose promise is
// dropped without `void` (`doIt();`) needs types to see and is not judged
// here; tsgo's no-floating rule is the place for that, not a text scan.
//
//   npx tsx scripts/lint-responses-wait-for-their-writes.ts   (pnpm lint responses-wait-for-their-writes)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOTS = ["api/src", "modules"];
const ROUTE_FILE = /\b\w*[Rr]outer\.(get|post|put|patch|delete)\(/;
const DETACHED = /\/\/\s*DETACHED:\s*\S.{8,}/;

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
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

function makesACall(node: ts.Node): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, (c) => (makesACall(c) ? true : undefined)) === true;
}

function isTheEventBus(node: ts.Node, src: ts.SourceFile): boolean {
  return /^(platform\(\)\.)?events\.emit\(/.test(node.getText(src).replace(/\s+/g, ""));
}

/** `(req, res, next) => { void (async () => { …answers… })().catch(next); }`:
 *  a synchronous handler whose body runs an async function that IS the
 *  handler. It writes the response itself, so nothing outlives it. */
function isTheHandlerItself(v: ts.VoidExpression, handler: ts.Node): boolean {
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return false;
  if (handler.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const body = handler.body;
  if (!ts.isBlock(body)) return false;
  const stmt = v.parent;
  if (!ts.isExpressionStatement(stmt) || stmt.parent !== body) return false;
  let call: ts.Expression = v.expression;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "catch") call = call.expression.expression;
  if (!ts.isCallExpression(call)) return false;
  let fn: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
  return (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

const CHAIN = new Set(["then", "catch", "finally"]);
function isLooseChain(stmt: ts.ExpressionStatement): boolean {
  const e = stmt.expression;
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && CHAIN.has(e.expression.name.text);
}

const METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);
/** `router.post(path, …handlers)`, `xRouter.get(…)`, `router.route(p).put(…)`:
 *  the handlers passed here are what answers a request. */
function isRouteRegistration(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!METHODS.has(node.expression.name.text)) return false;
  const target = node.expression.expression;
  if (ts.isIdentifier(target)) return /[Rr]outer$|^app$/.test(target.text);
  return ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === "route";
}

/** The line itself, or the comment lines directly above it, say DETACHED. */
function saysWhy(lines: string[], at: number): boolean {
  if (DETACHED.test(lines[at] ?? "")) return true;
  for (let i = at - 1; i >= 0; i--) {
    const l = (lines[i] ?? "").trim();
    if (!l.startsWith("//")) return false;
    if (DETACHED.test(l)) return true;
  }
  return false;
}

export function check(file: string, text: string): Violation[] {
  if (!ROUTE_FILE.test(text)) return [];
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const out: Violation[] = [];
  const flag = (node: ts.Node, what: string) => {
    const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line;
    if (!saysWhy(lines, line)) out.push({ file, line: line + 1, what });
  };
  const inHandler = (handler: ts.Node) => {
    const walk = (node: ts.Node) => {
      if (ts.isVoidExpression(node) && !ts.isReturnStatement(node.parent) && makesACall(node.expression) && !isTheEventBus(node.expression, src)) {
        if (!isTheHandlerItself(node, handler)) flag(node, "void starts work the response does not wait for");
      } else if (ts.isExpressionStatement(node) && isLooseChain(node) && !isTheEventBus(node.expression, src)) {
        flag(node, "a promise chain nobody awaits");
      }
      ts.forEachChild(node, walk);
    };
    walk(handler);
  };
  const visit = (node: ts.Node) => {
    if (isRouteRegistration(node)) {
      for (const arg of node.arguments) inHandler(arg);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  let judged = 0;
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      if (ROUTE_FILE.test(text)) judged++;
      violations.push(...check(file, text));
    }
  }
  if (violations.length) {
    console.error(`[lint:responses-wait-for-their-writes] ✗ ${violations.length} place(s) start work the response does not wait for:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Await it, or put // DETACHED: <why it may outlive the response> on the line or the comment directly above.");
    process.exit(1);
  }
  console.log(`[lint:responses-wait-for-their-writes] ✓ ${judged} route files, nothing detached without a reason`);
}
