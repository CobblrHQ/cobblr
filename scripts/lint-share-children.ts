#!/usr/bin/env tsx
// A module table whose rows belong to one record (a parent key that cascades on delete) is declared as share children, carried when the record is shared, or named with the reason it is not
//
// THE BUG THIS PREVENTS. A shared Pattern reached the friend without the needs
// its owner typed (#6252, 2026-10-13): they live in projects_pattern_needs,
// keyed to the pattern, and a share carried the record's own row only.
// Coordinator, 2026-10-13: shared records carry their child rows.
//
// THE RULE. Every table a module's migrations create with a column that
// references another of its tables `on delete cascade` holds rows that belong
// to a record. Each such table is either declared, by a module's
// platform().entities.registerShareChildren({ table: "<it>", ... }), or listed
// in scripts/share-children-exempt.json with the reason it does not travel (a
// run log, the owner's own use of the record, something worked out again on
// the other side). An exemption with no reason, or for a table that no longer
// exists or is now declared, fails too, so the list cannot rot.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A table that references
// itself (a place's parent place) is a tree of records of one kind, not rows
// that belong to another record: skipped. A reference without cascade (a part
// a need was matched to) is a link to another record, not ownership: not
// judged.
//
//   npx tsx scripts/lint-share-children.ts   (pnpm lint share-children)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MODULES = join(ROOT, "modules");
const EXEMPT_FILE = join(ROOT, "scripts", "share-children-exempt.json");

function* files(dir: string, ext: RegExp): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p, ext);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Split a create table body on its top-level commas. */
function columns(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const CASCADE = /\breferences\s+([a-z_][a-z0-9_]*)\s*\(\s*id\s*\)[^,]*\bon\s+delete\s+cascade\b/i;

/** Child table → [its parent, the migration that says so]. */
export function childTables(sqlByFile: Array<[string, string]>): Map<string, { parent: string; file: string }> {
  const out = new Map<string, { parent: string; file: string }>();
  for (const [file, raw] of sqlByFile) {
    const sql = raw.replace(/--[^\n]*/g, "");
    const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
    for (let m: RegExpExecArray | null; (m = create.exec(sql)); ) {
      const table = m[1]!.toLowerCase();
      let depth = 1;
      let i = create.lastIndex;
      for (; i < sql.length && depth > 0; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") depth--;
      }
      for (const col of columns(sql.slice(create.lastIndex, i - 1))) {
        const ref = CASCADE.exec(col);
        if (ref && ref[1]!.toLowerCase() !== table && !out.has(table)) out.set(table, { parent: ref[1]!.toLowerCase(), file });
      }
    }
    const alter = /alter\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([^;]*)/gi;
    for (let m: RegExpExecArray | null; (m = alter.exec(sql)); ) {
      const table = m[1]!.toLowerCase();
      const ref = CASCADE.exec(m[2]!);
      if (ref && ref[1]!.toLowerCase() !== table && !out.has(table)) out.set(table, { parent: ref[1]!.toLowerCase(), file });
    }
  }
  return out;
}

/** Tables a module declares: `table: "<name>"` in a file that registers share children. */
export function declaredTables(srcByFile: Array<[string, string]>): Set<string> {
  const out = new Set<string>();
  for (const [, src] of srcByFile) {
    if (!src.includes("registerShareChildren(")) continue;
    for (const m of src.matchAll(/\btable:\s*"([a-z_][a-z0-9_]*)"/g)) out.add(m[1]!);
  }
  return out;
}

export function judge(children: Map<string, { parent: string; file: string }>, declared: Set<string>, exempt: Record<string, string>): string[] {
  const why: string[] = [];
  for (const [table, { parent, file }] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    if (declared.has(table)) continue;
    const reason = exempt[table];
    if (typeof reason === "string" && reason.trim().length >= 10) continue;
    why.push(
      reason === undefined
        ? `${file}: ${table} belongs to a ${parent} row (on delete cascade). Declare it with platform().entities.registerShareChildren({ table: "${table}", ... }) so a shared record carries it, or add it to scripts/share-children-exempt.json with the reason it does not travel.`
        : `scripts/share-children-exempt.json: ${table} says no reason why it does not travel.`,
    );
  }
  for (const table of Object.keys(exempt)) {
    if (!children.has(table)) why.push(`scripts/share-children-exempt.json: ${table} is not a module table that belongs to a record any more; take it out.`);
    else if (declared.has(table)) why.push(`scripts/share-children-exempt.json: ${table} is declared as share children; take its exemption out.`);
  }
  return why;
}

function main(): void {
  const sql: Array<[string, string]> = [];
  for (const mod of readdirSync(MODULES)) {
    const dir = join(MODULES, mod, "migrations");
    if (!existsSync(dir)) continue;
    for (const f of files(dir, /\.sql$/)) sql.push([f.slice(ROOT.length + 1), readFileSync(f, "utf8")]);
  }
  const src: Array<[string, string]> = [];
  for (const f of files(MODULES, /\.tsx?$/)) {
    const text = readFileSync(f, "utf8");
    if (text.includes("registerShareChildren(")) src.push([f.slice(ROOT.length + 1), text]);
  }
  const exempt = JSON.parse(readFileSync(EXEMPT_FILE, "utf8")) as Record<string, string>;
  const why = judge(childTables(sql), declaredTables(src), exempt);
  if (why.length) {
    console.error(`lint:share-children - ${why.length} violation(s):`);
    for (const w of why) console.error(`  ${w}`);
    console.error("A shared record carries what the owner wrote about it (#6252): rows that belong to a record travel with it, or say why not.");
    process.exit(1);
  }
  console.log("lint:share-children - every module table that belongs to a record is carried or says why not.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) main();
