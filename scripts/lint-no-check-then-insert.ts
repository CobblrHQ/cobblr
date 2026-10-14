#!/usr/bin/env tsx
// A write that checks a row is absent and then inserts it, into a table with a unique key, never fails the second of two requests at once: the insert says ON CONFLICT, the function takes an advisory lock, or it catches the duplicate (23505); a genuine exception says check-then-insert: and why.
//
// THE BUG THIS PREVENTS. Two enables of one module at once: the second answered 500 duplicate key (#4922, 2026-10-05)
//
// THE RULE. Discovered, not listed: the tables come from every migration
// (api/migrations, modules/*/migrations) that gives one a unique key beyond a
// generated id (a composite primary key, a UNIQUE column or constraint, a
// unique index). In api/src and a module's server code, a function that reads
// such a table (selectFrom or deleteFrom) and then inserts into it with no
// `.onConflict(...)` is refused, unless the same function serialises itself
// (pg_advisory_xact_lock) or catches the duplicate (23505). Two requests at
// once both pass the read, and the second insert fails on the key: a 500 for
// something that, by then, exists. A genuine exception (the key is a random
// token that cannot collide) says `check-then-insert: <why>` on the insert's
// line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A function whose read is on
// some other column (a discussion's pending reply) is still flagged when its
// table has a key: the cheap answer is to state why on the line. Tables keyed
// only by a generated id are out of scope: nothing a person sends collides.
//
//   npx tsx scripts/lint-no-check-then-insert.ts   (pnpm lint no-check-then-insert)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

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
    else if (/\.(ts|sql)$/.test(name)) yield p;
  }
}

/** Tables with a unique key a request can collide on, read from the migrations. */
function keyedTables(): Set<string> {
  const keyed = new Set<string>();
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const f of walk(dir)) if (f.endsWith(".sql")) files.push(f);
  };
  collect("api/migrations");
  for (const m of readdirSync("modules")) collect(join("modules", m, "migrations"));
  for (const f of files) {
    const sqlText = readFileSync(f, "utf8").toLowerCase();
    for (const m of sqlText.matchAll(/create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
      const [, t, body] = m;
      // A table-level key, or a column-level one a request supplies. A column
      // with a DEFAULT (a sequence, a generated id) is the database's to fill
      // and cannot collide with a request.
      if (/primary key\s*\(/.test(body!) || /^\s*(constraint \w+ )?unique\s*\(/m.test(body!)) keyed.add(t!);
      for (const line of body!.split("\n")) if (/\b(primary key|unique)\b/.test(line) && !/\bdefault\b/.test(line) && !/^\s*(primary key|unique|constraint)/.test(line.trim()) && !/^\s*id\s/.test(line)) keyed.add(t!);
    }
    for (const m of sqlText.matchAll(/create unique index (?:if not exists )?\w+\s+on\s+(\w+)/g)) keyed.add(m[1]!);
    for (const m of sqlText.matchAll(/alter table (?:if exists )?(\w+)[^;]*add (?:constraint \w+ )?unique\s*\(/g)) keyed.add(m[1]!);
  }
  return keyed;
}
const KEYED = keyedTables();

const inScope = (file: string) => file.endsWith(".ts") && !/\.test\.ts$/.test(file) && (!file.startsWith("modules/") || (/\/src\//.test(file) && !/\/src\/ui\//.test(file)));

function check(file: string, src: string): Violation[] {
  if (!inScope(file) || !src.includes("insertInto(")) return [];
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = src.split("\n");
  const said = (line: number) => /check-then-insert:\s*\S/.test(lines[line - 1] ?? "") || /check-then-insert:\s*\S/.test(lines[line - 2] ?? "");
  const visitFn = (fn: ts.FunctionLikeDeclaration) => {
    const text = fn.getText(sf);
    if (/pg_advisory_xact_lock|23505|isUnique(Violation)?\(/.test(text)) return;
    const read = new Set<string>();
    const inserts: Array<{ t: string; line: number; guarded: boolean }> = [];
    const v = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n)) return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const name = n.expression.name.text;
        const t = n.arguments[0].text.split(/\s/)[0]!;
        if (name === "selectFrom" || name === "deleteFrom") read.add(t);
        if (name === "insertInto") {
          let top: ts.Node = n;
          while (top.parent && (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent))) top = top.parent;
          inserts.push({ t, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, guarded: /\.onConflict\(/.test(top.getText(sf)) });
        }
      }
      ts.forEachChild(n, v);
    };
    if (fn.body) ts.forEachChild(fn.body, v);
    for (const i of inserts) {
      if (i.guarded || !KEYED.has(i.t) || !read.has(i.t) || said(i.line)) continue;
      out.push({ file, line: i.line, what: `${i.t}: read, then inserted with no onConflict; two requests at once fail the second on its key` });
    }
  };
  const all = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) visitFn(n as ts.FunctionLikeDeclaration);
    ts.forEachChild(n, all);
  };
  all(sf);
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-check-then-insert - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Add .onConflict(...) returning the existing row, take pg_advisory_xact_lock in a transaction, or catch 23505; or write // check-then-insert: <why>.");
  process.exit(1);
}
console.log(`lint:no-check-then-insert OK`);
