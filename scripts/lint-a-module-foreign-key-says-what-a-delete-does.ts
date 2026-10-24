#!/usr/bin/env tsx
// A foreign key in a module migration says what deleting the row it points at does (ON DELETE CASCADE, SET NULL, RESTRICT or NO ACTION), or a later migration of the module gives it one: a key with no rule refuses the delete with a 500 nobody chose.
//
// THE BUG THIS PREVENTS. #7905, 2026-10-22: deleting a received component
// package answered 500. Its receipt row's key into inventory_parts had no
// delete rule, so Postgres refused the delete, and the route had already
// unlinked the package's other stock place before it tried.
//
// THE RULE. Every REFERENCES in modules/*/migrations, in a CREATE TABLE
// column, a table-level FOREIGN KEY or an ALTER TABLE ... ADD, carries an
// ON DELETE clause. CASCADE is usually right for a row that belongs to its
// parent: the deletion snapshot (snapshotRowTree) keeps cascaded rows of the
// module and Undo puts them back. A key that should refuse says RESTRICT or
// NO ACTION out loud, and the route answers that refusal in words. A
// migration is immutable once merged, so an old key is healed by a later
// migration of the same module that adds the same table and column's key
// again with a rule. The keys that predate this rule are listed below by
// name with the issue that decides each one; the list only shrinks.
//
// THE BOUNDARY. Module migrations only: the platform migrations' keys into
// users and orgs point at rows no workspace route deletes, and none of them
// has failed a delete. Nothing has tested the boundary yet beyond that.
//
//   pnpm lint a-module-foreign-key-says-what-a-delete-does
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";
import { stripNonExecutable } from "../api/src/db/migration-shape.js";

/** Keys that predate the rule, by module/table.column, each with the issue
 *  that decides its delete rule. Remove a line when its heal lands. */
const DECIDED_ELSEWHERE: Record<string, string> = {};

interface Key { module: string; table: string; column: string; file: string; line: number; rule: boolean }

/** Split on commas outside parentheses. */
function topLevel(body: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { out.push({ text: body.slice(start, i), at: start }); start = i + 1; }
  }
  out.push({ text: body.slice(start), at: start });
  return out;
}

const NAME = String.raw`(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?`;

/** Every foreign key one migration declares, with whether it says ON DELETE. */
export function keysIn(sql: string, where: { module: string; file: string }): Key[] {
  const src = stripNonExecutable(sql);
  const lineAt = (at: number) => src.slice(0, at).split("\n").length;
  const out: Key[] = [];
  const push = (table: string, column: string, text: string, at: number) =>
    out.push({ ...where, table: table.toLowerCase(), column: column.toLowerCase(), line: lineAt(at), rule: /\bON\s+DELETE\b/i.test(text) });
  let at = 0;
  for (const stmt of src.split(";")) {
    const here = at;
    at += stmt.length + 1;
    const create = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s*\(`, "i").exec(stmt);
    if (create) {
      const open = create.index + create[0].length;
      const close = stmt.lastIndexOf(")");
      for (const part of topLevel(stmt.slice(open, close))) {
        if (!/\bREFERENCES\b/i.test(part.text)) continue;
        const fk = /FOREIGN\s+KEY\s*\(\s*"?([a-z0-9_]+)"?/i.exec(part.text);
        const col = fk?.[1] ?? /^\s*"?([a-z0-9_]+)"?/i.exec(part.text)?.[1];
        if (col) push(create[1]!, col, part.text, here + open + part.at + (part.text.length - part.text.trimStart().length));
      }
      continue;
    }
    const alter = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}`, "i").exec(stmt);
    if (!alter) continue;
    for (const part of topLevel(stmt.slice(alter.index + alter[0].length))) {
      if (!/\bREFERENCES\b/i.test(part.text)) continue;
      const fk = /FOREIGN\s+KEY\s*\(\s*"?([a-z0-9_]+)"?/i.exec(part.text);
      const col = fk?.[1] ?? /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(part.text)?.[1];
      if (col) push(alter[1]!, col, part.text, here + alter.index + alter[0].length + part.at + (part.text.length - part.text.trimStart().length));
    }
  }
  return out;
}

/** The keys still without a rule once every migration of a module has run. */
export function unruled(keys: Key[]): Key[] {
  const last = new Map<string, Key>();
  for (const k of keys) last.set(`${k.table}.${k.column}`, k);
  return [...last.values()].filter((k) => !k.rule);
}

function main(): void {
  const found: Key[] = [];
  const byModule = new Map<string, string[]>();
  for (const file of sourceFiles("modules/*/migrations/*.sql").sort()) {
    const module = file.split(/[\\/]/)[1]!;
    byModule.set(module, [...(byModule.get(module) ?? []), file]);
  }
  for (const [module, files] of byModule) {
    found.push(...unruled(files.flatMap((file) => keysIn(readFileSync(file, "utf8"), { module, file }))));
  }
  const named = (k: Key) => `${k.module}/${k.table}.${k.column}`;
  const violations = found.filter((k) => !DECIDED_ELSEWHERE[named(k)]);
  const stale = Object.keys(DECIDED_ELSEWHERE).filter((n) => !found.some((k) => named(k) === n));
  if (violations.length || stale.length) {
    console.error(`lint:a-module-foreign-key-says-what-a-delete-does - ${violations.length + stale.length} violation(s):`);
    for (const k of violations) console.error(`  ${k.file}:${k.line}  ${k.table}.${k.column} references a row with no ON DELETE rule`);
    for (const n of stale) console.error(`  ${n} is listed as decided elsewhere but has a rule now: take it off the list`);
    console.error("add ON DELETE CASCADE (the row goes with its parent and comes back on Undo), SET NULL, or RESTRICT/NO ACTION when refusing is meant");
    process.exit(1);
  }
  console.log(`lint:a-module-foreign-key-says-what-a-delete-does OK`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
