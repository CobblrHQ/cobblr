#!/usr/bin/env tsx
// A migration that adds a bytea column says in a LIFETIME line what drops its bytes and when, because a blob nobody lets go of grows every nightly dump.
//
// THE BUG THIS PREVENTS. #8941: suggestion pictures held whole with no lifetime grew staging's dumps from 123 MB to 1.3 GB and filled the disk, 2026-10-30
// Migration 0046 of core-scan added held_bytes and said when a picture was
// written into it, never when it left. Every unanswered suggestion kept its
// whole download for good, and every nightly dump carried them all.
//
// THE RULE. A bytea column added in a migration (a column of a create table,
// or an add column) passes when a migration in the same directory has a
// comment line `-- LIFETIME: <column> ...` that says what drops its bytes
// and when: overwritten in place, deleted with its row after N days, cleared
// on an answer. The line may sit in a later migration of the directory,
// because a merged migration is never edited: that is how 0047 states
// 0046's. A column added before this lint is in PRE_LINT below with its
// lifetime written out; that list is closed, and a new column states its own.
//
// THE BOUNDARY. Only bytea: a text or jsonb column can grow too, but a blob
// is the column whose single value is megabytes, and a lifetime for every
// text column would be noise nobody reads. Only migrations: where the column
// is born is where its author is thinking about it.
//
//   npx tsx scripts/lint-blob-columns-state-their-lifetime.ts   (pnpm lint blob-columns-state-their-lifetime)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOTS = ["api/migrations", "modules"];

/** Columns added before this lint, keyed `<migration file>:<column>`, each
 *  with the lifetime its code gives it. Closed: never add to it. */
const PRE_LINT: Record<string, string> = {
  "api/migrations/platform/20260830-115-try-sandbox-exports.sql:bytes": "one export per asking visitor, deleted at expires_at (indexed) by the sandbox reaper",
  "api/migrations/platform/20260930-171-personal-exports.sql:bytes": "a person's own export, kept seven days (expires_at), then deleted",
  "modules/labels/migrations/0013_autoflush_dispatch_intent.sql:dispatch_document": "an auto-printed batch's rendered document, held only until its print job is scheduled",
  "modules/projects/migrations/0003_pattern_photo.sql:thumb": "a small thumbnail per candidate image of one pattern file, a fixed handful per design",
  "modules/digifab/migrations/0013_device_snapshots.sql:jpeg": "one frame per device, overwritten on each push, written only while the relay is on",
};

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* sqlFiles(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sqlFiles(p);
    else if (name.endsWith(".sql") && /(^|\/)migrations(\/|$)/.test(dir)) yield p;
  }
}

/** The bytea columns a migration adds, with their lines. */
export function blobColumns(src: string): Array<{ column: string; line: number }> {
  const out: Array<{ column: string; line: number }> = [];
  src.split("\n").forEach((raw, i) => {
    const code = raw.replace(/--.*$/, "");
    for (const m of code.matchAll(/(?:^|[(,\s])"?([A-Za-z_][A-Za-z0-9_]*)"?\s+bytea\b/gi)) {
      const column = m[1]!.toLowerCase();
      if (column === "type" || column === "as") continue;
      out.push({ column, line: i + 1 });
    }
  });
  return out;
}

/** The columns a directory's migrations state a lifetime for. */
export function statedLifetimes(sources: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const src of sources) for (const m of src.matchAll(/^\s*--\s*LIFETIME:\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+\S/gim)) out.add(m[1]!.toLowerCase());
  return out;
}

const byDir = new Map<string, string[]>();
for (const root of ROOTS) for (const f of sqlFiles(root)) byDir.set(dirname(f), [...(byDir.get(dirname(f)) ?? []), f]);

const violations: Violation[] = [];
for (const [, files] of byDir) {
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const stated = statedLifetimes([...sources.values()]);
  for (const [file, src] of sources) {
    for (const { column, line } of blobColumns(src)) {
      if (stated.has(column) || PRE_LINT[`${file}:${column}`]) continue;
      violations.push({ file, line, what: `bytea column ${column} has no "-- LIFETIME: ${column} <what drops its bytes, and when>" in this directory's migrations` });
    }
  }
}

if (violations.length) {
  console.error(`lint:blob-columns-state-their-lifetime - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add '-- LIFETIME: <column> <what drops its bytes, and when>' to the migration's header (or a later migration's, for a merged one)");
  process.exit(1);
}
console.log(`lint:blob-columns-state-their-lifetime OK`);
