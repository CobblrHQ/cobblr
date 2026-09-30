#!/usr/bin/env tsx
// Every shared-database table that holds a workspace's rows says whether a backup carries it.
//
// THE BUG THIS PREVENTS. A workspace keeps rows in two places: its own
// database, which the backup dumps whole, and `org_id`-keyed tables in the
// shared platform database. The backup read only the first. A backup restored
// into a fresh workspace came back with every record and none of the links
// between them, none of its people, field sections, menu headings or printed
// label tokens, and reported success (the 2026-09 fundamentals audit, proven
// on staging: one pairing in the source, none after the restore).
//
// THE RULE. Every table a platform migration creates with an `org_id` column
// (or gives one later with `alter table ... add column org_id`) has an entry
// in SHARED_WORKSPACE_TABLES (api/src/platform/workspace-shared-tables.ts):
// `backup` (the archive carries and restores it), `blueprint` (the Blueprint
// inside every backup does), or `never` with the reason. A missing entry
// fails, and so does an entry naming a table no migration creates (or one a
// later migration drops), so the list cannot rot into describing tables that
// are gone. There is no annotation to opt out: `never` with a reason IS the
// opt-out, and it sits where the next reader of the backup looks.
//
// THE BOUNDARY. A table with no `org_id` of its own, reached only through a
// parent (tag_assignments through tags), is its parent's business and is not
// listed; a restore of the parent brings it or the parent's entry says why
// not. Nothing has tested that boundary with a real miss yet.
//
// PROVE IT RED: delete `entity_pairings` from the list and run it.
//
//   npx tsx scripts/lint-backup-covers-shared-tables.ts   (pnpm lint backup-covers-shared-tables)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SHARED_WORKSPACE_TABLES } from "../api/src/platform/workspace-shared-tables.ts";

const DIR = "api/migrations/platform";
const REGISTRY = "api/src/platform/workspace-shared-tables.ts";

interface Found {
  file: string;
  line: number;
}
const withOrg = new Map<string, Found>();
const dropped = new Set<string>();
const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

for (const name of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
  const file = join(DIR, name);
  const src = readFileSync(file, "utf8");
  const code = src.replace(/--[^\n]*/g, (c) => " ".repeat(c.length));
  for (const m of code.matchAll(/create table (?:if not exists )?([a-z0-9_]+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
    const table = m[1]!.toLowerCase();
    dropped.delete(table);
    if (/(^|[\s,(])org_id\s/im.test(m[2]!)) withOrg.set(table, { file, line: lineOf(src, m.index!) });
  }
  for (const m of code.matchAll(/alter table (?:if exists )?(?:only )?([a-z0-9_]+)[^;]*?add column (?:if not exists )?org_id\b/gi)) {
    const table = m[1]!.toLowerCase();
    if (!withOrg.has(table)) withOrg.set(table, { file, line: lineOf(src, m.index!) });
  }
  for (const m of code.matchAll(/drop table (?:if exists )?([a-z0-9_]+)/gi)) {
    const table = m[1]!.toLowerCase();
    withOrg.delete(table);
    dropped.add(table);
  }
}

const problems: string[] = [];
for (const [table, at] of withOrg) {
  if (!(table in SHARED_WORKSPACE_TABLES)) {
    problems.push(
      `${at.file}:${at.line}  ${table} holds a workspace's rows (org_id) and ${REGISTRY} does not say whether a backup carries it`,
    );
  }
}
for (const table of Object.keys(SHARED_WORKSPACE_TABLES)) {
  if (!withOrg.has(table)) {
    problems.push(
      `${REGISTRY}  ${table} is listed but ${dropped.has(table) ? "a migration drops it" : "no platform migration creates it with an org_id"}; remove the entry`,
    );
  }
}

if (problems.length) {
  console.error(`lint:backup-covers-shared-tables - ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "Give the table an entry in SHARED_WORKSPACE_TABLES: backup (restored with the workspace), blueprint, or never with the reason.",
  );
  process.exit(1);
}
console.log(`lint:backup-covers-shared-tables OK (${withOrg.size} shared tables, each with an answer)`);
