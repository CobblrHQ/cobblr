// Lint: no live foreign key may reference a DEPRECATED table.
//
// When a table's data is extracted to a platform store (e.g. digifab_connections
// → the device-connection store, core_devices_connections), the old table is kept
// briefly as a backfilled copy but is NO LONGER WRITTEN. Any FK still pointing at
// it silently works for rows that existed at extraction time, then BREAKS the
// first time code references a row created AFTER the extraction (the store never
// wrote it to the old copy). That's exactly the bug the pools feature hit:
// `digifab_jobs.connection_id` (and `digifab_device_links.connection_id`) still
// FK'd `digifab_connections`, so stamping a freshly-created connection threw
// `violates foreign key constraint`.
//
// This lint walks every module's migrations IN ORDER, tracks each FK's live state
// (created by a `references`, cleared by a `drop constraint` or `drop table`), and
// fails if any FK to a table on DEPRECATED_TABLES is still live at the end. So the
// moment a table is marked deprecated here, CI forces every inbound FK to be
// dropped — and a NEW migration can never add one back.
//
// Run: npx tsx scripts/lint-deprecated-table-fks.ts   (wired into CI's lint set)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tables whose data now lives in a platform store / another table. Add one here
 *  the moment you extract a table; the lint then requires its inbound FKs gone. */
const DEPRECATED_TABLES: Record<string, string> = {
  digifab_connections:
    "superseded by the platform device-connection store (core_devices_connections, meta DB) in the core-devices extraction — drop its inbound FKs (and eventually the table itself, the two-phase tail)",
};

/** Strip -- line comments and /* *​/ block comments, preserving newlines. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, "");
}

interface LiveFk {
  constraint: string; // pg name: <table>_<col>_fkey (or an explicit name)
  table: string; // current dependent table (tracked through renames)
  column: string;
  refTable: string;
  file: string;
}

const live = new Map<string, LiveFk>();

function addColumnFk(table: string, column: string, refTable: string, file: string, explicitName?: string) {
  if (!(refTable in DEPRECATED_TABLES)) return; // only track FKs we care about
  const constraint = explicitName ?? `${table}_${column}_fkey`;
  live.set(constraint, { constraint, table, column, refTable, file });
}

function processSql(sql: string, file: string) {
  const src = stripComments(sql);

  // create table <T> ( ... ) — scan each comma-separated piece for a column FK.
  for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi)) {
    const table = m[1]!.toLowerCase();
    const body = m[2]!;
    for (const seg of body.split(/,(?![^(]*\))/)) {
      const ref = seg.match(/references\s+"?(\w+)"?/i);
      if (!ref) continue;
      const refTable = ref[1]!.toLowerCase();
      // table-level: foreign key (col) references D ; else column-level: <col> ...
      const tlevel = seg.match(/foreign\s+key\s*\(\s*"?(\w+)"?\s*\)/i);
      const named = seg.match(/constraint\s+"?(\w+)"?\s+foreign\s+key/i);
      const col = (tlevel?.[1] ?? seg.trim().match(/^"?(\w+)"?/)?.[1] ?? "").toLowerCase();
      if (col) addColumnFk(table, col, refTable, file, named?.[1]?.toLowerCase());
    }
  }

  // alter table <T> add column <col> ... references <D>
  for (const m of src.matchAll(/alter\s+table\s+"?(\w+)"?\s+add\s+column\s+"?(\w+)"?[^;]*?references\s+"?(\w+)"?/gi)) {
    addColumnFk(m[1]!.toLowerCase(), m[2]!.toLowerCase(), m[3]!.toLowerCase(), file);
  }
  // alter table <T> add constraint <name> foreign key (<col>) references <D>
  for (const m of src.matchAll(/alter\s+table\s+"?(\w+)"?\s+add\s+constraint\s+"?(\w+)"?\s+foreign\s+key\s*\(\s*"?(\w+)"?\s*\)\s*references\s+"?(\w+)"?/gi)) {
    addColumnFk(m[1]!.toLowerCase(), m[3]!.toLowerCase(), m[4]!.toLowerCase(), file, m[2]!.toLowerCase());
  }

  // alter table <T> rename to <T2> — follow the dependent table name.
  for (const m of src.matchAll(/alter\s+table\s+"?(\w+)"?\s+rename\s+to\s+"?(\w+)"?/gi)) {
    const from = m[1]!.toLowerCase();
    const to = m[2]!.toLowerCase();
    for (const fk of live.values()) if (fk.table === from) fk.table = to;
  }

  // alter table ... drop constraint [if exists] <name>
  for (const m of src.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?"?(\w+)"?/gi)) {
    live.delete(m[1]!.toLowerCase());
  }

  // drop table [if exists] <T> — clears every FK that lived on it.
  for (const m of src.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?"?(\w+)"?/gi)) {
    const t = m[1]!.toLowerCase();
    for (const [k, fk] of live) if (fk.table === t) live.delete(k);
  }
}

const modulesDir = join(ROOT, "modules");
for (const mod of readdirSync(modulesDir)) {
  const migDir = join(modulesDir, mod, "migrations");
  if (!existsSync(migDir)) continue;
  for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
    processSql(readFileSync(join(migDir, f), "utf8"), `modules/${mod}/migrations/${f}`);
  }
}

const offenders = [...live.values()].filter((fk) => fk.refTable in DEPRECATED_TABLES);
if (offenders.length) {
  console.error(`❌ ${offenders.length} live FK(s) reference a DEPRECATED table:\n`);
  for (const fk of offenders) {
    console.error(`  ${fk.table}.${fk.column} → ${fk.refTable}  (constraint ${fk.constraint})`);
    console.error(`      ${DEPRECATED_TABLES[fk.refTable]}`);
    console.error(`      Fix: add \`alter table ${fk.table} drop constraint if exists ${fk.constraint};\` to a new/uncommitted migration.\n`);
  }
  process.exit(1);
}
console.log(`✓ no live FK references a deprecated table (${Object.keys(DEPRECATED_TABLES).length} on the watch-list)`);
