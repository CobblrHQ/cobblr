#!/usr/bin/env tsx
// An api test never names a workspace or an account with a fixed literal in a request that makes one: those names are unique across the whole instance, so a fixed one collides with what another test file left in CI's shared database; use uniqueName(), or say shared-name: and why.
//
// THE BUG THIS PREVENTS. POST /orgs creates a second workspace passed only on retry: another file had or had not taken second-workspace (#4892, 2026-10-05)
//
// THE RULE. In api/tests, a call that makes a workspace or an account (its
// path is /orgs, /auth/signup, /auth/identity/signup, an accept-signup, or
// /admin/users) never gives it a fixed literal `name`, `org_name`, `email` or
// `source` (a sign-up's source is an instance-wide tally, #4900). Those are unique across
// the whole instance, and CI runs every file against one database, so a fixed
// one depends on whether another file got there first. uniqueName() from
// ./helpers.js gives each run its own. A name that must be fixed (the platform
// admin CI lists in SUPERADMIN_EMAILS) says `shared-name: <why>` on its line
// or the one above.
//
// It follows a literal one level into a local helper: `signUp("3DP2026")`,
// where signUp(source) sends `source` to /auth/signup, is the same fixed
// source (#4900's own shape, which a body-only rule missed).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A record's name inside the
// test's own workspace is not in scope: nothing outside that workspace can
// see it (1,960 such literals, none ever collided). Nor is an email passed to
// a pure function under test: only a request that makes the thing counts.
//
//   npx tsx scripts/lint-tests-own-their-names.ts   (pnpm lint tests-own-their-names)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];

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
    else if (/\.ts$/.test(name)) yield p;
  }
}

const MAKES = /\/orgs$|\/auth\/signup$|\/auth\/identity\/signup$|\/accept-signup$|\/admin\/users$/;
// `source`: a sign-up's source is counted across the whole instance, so a
// fixed one is a tally other files add to (#4900).
const NAMED = new Set(["name", "org_name", "email", "source"]);

/** The path a call makes things at, when one of its arguments names one. */
function makesPath(n: ts.CallExpression): string | null {
  const a = n.arguments.find((x) => (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && MAKES.test(x.text));
  return a ? (a as ts.StringLiteral).text : null;
}

/** Every `prop: <expr>` (or shorthand `prop`) in the call's non-path arguments. */
function namedProps(n: ts.CallExpression, visit: (prop: string, init: ts.Expression | null, at: ts.Node) => void): void {
  const look = (o: ts.Node): void => {
    if (ts.isPropertyAssignment(o) && ts.isIdentifier(o.name) && NAMED.has(o.name.text)) visit(o.name.text, o.initializer, o);
    if (ts.isShorthandPropertyAssignment(o) && NAMED.has(o.name.text)) visit(o.name.text, null, o);
    ts.forEachChild(o, look);
  };
  for (const a of n.arguments) look(a);
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = src.split("\n");
  const said = (line: number) => /shared-name:\s*\S/.test(lines[line - 1] ?? "") || /shared-name:\s*\S/.test(lines[line - 2] ?? "");
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const isLiteral = (e: ts.Node | null | undefined): e is ts.StringLiteral => !!e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e));

  // One level into a local helper (#4900): `signUp(source)` that sends
  // `source` to a path that makes things, called as `signUp("3DP2026")`.
  const helpers = new Map<string, Array<{ index: number; prop: string; path: string }>>();
  const noteHelper = (name: string, params: ts.NodeArray<ts.ParameterDeclaration>, body: ts.Node) => {
    const names = params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    const found: Array<{ index: number; prop: string; path: string }> = [];
    const walkBody = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const path = makesPath(n);
        if (path) {
          namedProps(n, (prop, init) => {
            const ref = init === null ? prop : init && ts.isIdentifier(init) ? init.text : null;
            const index = ref ? names.indexOf(ref) : -1;
            if (index >= 0) found.push({ index, prop, path });
          });
        }
      }
      ts.forEachChild(n, walkBody);
    };
    walkBody(body);
    if (found.length) helpers.set(name, found);
  };
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) noteHelper(n.name.text, n.parameters, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      noteHelper(n.name.text, n.initializer.parameters, n.initializer.body);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const path = makesPath(n);
      if (path) {
        namedProps(n, (prop, init, at) => {
          if (isLiteral(init) && !said(lineOf(at))) {
            out.push({ file, line: lineOf(at), what: `a fixed ${prop} ("${init.text}") for what ${path} makes: use uniqueName(), or say shared-name: <why>` });
          }
        });
      }
      if (ts.isIdentifier(n.expression) && helpers.has(n.expression.text)) {
        for (const h of helpers.get(n.expression.text)!) {
          const arg = n.arguments[h.index];
          if (isLiteral(arg) && !said(lineOf(arg))) {
            out.push({ file, line: lineOf(arg), what: `a fixed ${h.prop} ("${arg.text}") through ${n.expression.text}() for what ${h.path} makes: use uniqueName(), or say shared-name: <why>` });
          }
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
  console.error(`lint:tests-own-their-names - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use uniqueName(\"prefix\") from ./helpers.js, or write // shared-name: <why> on the line or the one above.");
  process.exit(1);
}
console.log(`lint:tests-own-their-names OK`);
