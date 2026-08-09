// Every table that names an entity KIND must have an opinion about what happens
// when a record moves between instances.
//
// Moving a record from one instance to another changes the kind string it
// answers to (`bookshelf:item` -> `inventory:part`) while its uuid stays put.
// Anything storing that kind alongside an id is a soft reference with NO
// foreign key, so a table nobody remembered to rewrite does not error. A tag,
// a printed QR label, or a purchase line just quietly points at a kind the
// record no longer is.
//
// This lint exists because that is not a hypothetical. The design spec's
// hand-written satellite list was careful, reviewed, and MISSED FIVE TABLES
// (inventory allocations, purchase consumed-by refs, task dependencies,
// committed scan items, the AI writes ledger). A mechanical enumeration found
// them in one pass. So the enumeration is the source of truth and the code's
// list is what gets checked against it, never the other way around.
//
// Every kind-referencing table must be declared in api/src/platform/
// instance-move.ts as exactly one of:
//
//   SATELLITE_TABLES      - rewritten during a move (it points AT the record)
//   KIND_SCOPED_CONFIG    - left alone (it belongs to the INSTANCE, not the
//                           record; moving one book must not drag the
//                           Bookshelf's view layout onto Inventory)
//
// Adding a kind-keyed table therefore forces the decision at authoring time,
// which is the only time anybody has the context to make it.
//
// Run: npx tsx scripts/lint-instance-move-satellites.ts

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** A column naming an entity KIND. `*_module` alone is not enough (it says
 *  which module, not which kind), but it always sits beside one of these.
 *
 *  There are FOUR naming conventions in this tree for the same idea, which is
 *  the second reason a hand-written list cannot be trusted: `entity_*`,
 *  `target_*`, `source_*`, and `consumed_by_*`. The live tags table uses
 *  `source_type` and was invisible to an earlier version of this regex that
 *  only knew the first two. */
const KIND_COL =
  /^\s*(entity_kind|entity_type|target_kind|target_entity_type|source_kind|source_type|consumed_by_entity_type)\b/m;

const MIGRATION_DIRS = ["api/migrations/platform", "api/migrations/tenant-base"];

type Table = { name: string; file: string };

/** table -> its column names, harvested from the create-table bodies. */
const columnsByTable = new Map<string, Set<string>>();

/** Parse `create table <name> ( ... );` blocks and report the ones whose body
 *  names a kind column. Deliberately dumb: migrations here are hand-written
 *  SQL in a consistent house style, and a parser clever enough to be wrong is
 *  worse than one that is obviously limited. */
function kindTablesIn(sql: string, file: string): Table[] {
  const found: Table[] = [];
  const re = /create table (?:if not exists )?([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const [, name, body] = m;
    if (!name || !body) continue;
    // Record every column, so a descriptor can be checked against the real DDL
    // rather than against a naming pattern that happens to be wrong.
    const cols = new Set<string>();
    for (const line of body.split("\n")) {
      const c = /^\s{2,}([a-z][a-z0-9_]*)\s+(text|uuid|int|integer|boolean|numeric|timestamptz|date|jsonb|bigint|smallint|real)/.exec(line);
      if (c?.[1]) cols.add(c[1]);
    }
    if (cols.size) columnsByTable.set(name, new Set([...(columnsByTable.get(name) ?? []), ...cols]));
    if (KIND_COL.test(body)) found.push({ name, file });
  }
  // `alter table X add column entity_kind ...` counts too.
  const alter = /alter table\s+([a-z0-9_]+)\s+add column\s+([a-z0-9_]+)/gi;
  while ((m = alter.exec(sql))) {
    const [, name, col] = m;
    if (!name || !col) continue;
    if (KIND_COL.test(`  ${col} `)) found.push({ name, file });
  }
  return found;
}

function collectMigrationFiles(): string[] {
  const files: string[] = [];
  for (const dir of MIGRATION_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".sql")) files.push(join(dir, f));
  }
  if (existsSync("modules")) {
    for (const mod of readdirSync("modules")) {
      const dir = join("modules", mod, "migrations");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) if (f.endsWith(".sql")) files.push(join(dir, f));
    }
  }
  return files;
}

const DECL = "api/src/platform/instance-move.ts";
if (!existsSync(DECL)) {
  console.error(`✗ lint-instance-move-satellites: ${DECL} is missing.`);
  console.error("  It must export SATELLITE_TABLES and KIND_SCOPED_CONFIG.");
  process.exit(1);
}
const decl = readFileSync(DECL, "utf8");

/** Read a `export const NAME = [...]` string-literal array out of the source
 *  without importing it, so the lint stays a plain file read and never boots
 *  the api (which would need a database). */
function declaredList(name: string, objects = false): Set<string> {
  const block = new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`).exec(decl);
  // `block[1] === ""` is a legitimately empty list, so test the MATCH, not the
  // capture. (Testing the capture rejected an empty array as a missing export.)
  if (block === null) {
    console.error(`✗ lint-instance-move-satellites: ${DECL} exports no ${name}.`);
    process.exit(1);
  }
  // Strip `//` comments first. These lists carry a reason per entry, and a
  // reason that quotes a value ("target_kind here is 'module' | 'instance'")
  // otherwise reads as two more declared tables.
  const body = block[1]!.replace(/\/\/[^\n]*/g, "");
  // SATELLITE_TABLES holds descriptor objects (table + columns), so pull only
  // the `table:` values; KIND_SCOPED_CONFIG is a plain name list.
  const re = objects ? /\btable:\s*["'`]([a-z0-9_]+)["'`]/g : /["'`]([a-z0-9_]+)["'`]/g;
  return new Set([...body.matchAll(re)].map((m) => m[1]!));
}

const satellites = declaredList("SATELLITE_TABLES", true);

/** Full descriptors, so the declared column names can be checked against the
 *  DDL. Read as text for the same reason as declaredList: no api boot. */
const descriptors: Array<{ table: string; kindCol?: string; idCol?: string; moduleCol?: string }> = [];
{
  const block = /SATELLITE_TABLES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(decl);
  for (const entry of (block?.[1] ?? "").split(/\},\s*/)) {
    const table = /\btable:\s*["'`]([a-z0-9_]+)["'`]/.exec(entry)?.[1];
    if (!table) continue;
    descriptors.push({
      table,
      kindCol: /\bkindCol:\s*["'`]([a-z0-9_]+)["'`]/.exec(entry)?.[1],
      idCol: /\bidCol:\s*["'`]([a-z0-9_]+)["'`]/.exec(entry)?.[1],
      moduleCol: /\bmoduleCol:\s*["'`]([a-z0-9_]+)["'`]/.exec(entry)?.[1],
    });
  }
}
const config = declaredList("KIND_SCOPED_CONFIG");

const seen = new Map<string, string>();
for (const file of collectMigrationFiles()) {
  for (const t of kindTablesIn(readFileSync(file, "utf8"), file)) {
    if (!seen.has(t.name)) seen.set(t.name, t.file);
  }
}

// A descriptor naming a column the table does not have fails at RUNTIME, with
// `column "entity_id" does not exist`, on a move somebody is doing to their
// real data. That happened: three tables were declared from a pattern rather
// than from their DDL (core_ai_calls is source_*, labels_prints and
// labels_queue are entity_type not entity_kind). Checking the columns here
// turns that into a build failure.
const badColumns: string[] = [];
for (const [, cols] of [...columnsByTable]) void cols;
for (const d of descriptors) {
  const cols = columnsByTable.get(d.table);
  if (!cols) continue; // table itself is reported by the undeclared/phantom checks
  for (const [role, col] of [
    ["kindCol", d.kindCol],
    ["idCol", d.idCol],
    ["moduleCol", d.moduleCol],
  ] as const) {
    if (!col) continue;
    if (!cols.has(col)) {
      badColumns.push(
        `${d.table}.${col} (declared as ${role}) does not exist. Columns are: ` +
          `${[...cols].sort().join(", ")}`,
      );
    }
  }
}

const undeclared = [...seen.entries()].filter(
  ([name]) => !satellites.has(name) && !config.has(name),
);
// A declared table that no longer exists is also a bug: the list drifted and
// the move is rewriting nothing, or worse, the reader trusts a stale list.
const phantom = [...satellites, ...config].filter((name) => !seen.has(name));

if (undeclared.length || phantom.length || badColumns.length) {
  console.error("✗ lint-instance-move-satellites: kind-keyed tables and the move disagree:");
  for (const [name, file] of undeclared) {
    console.error(
      `  ${name} (${file}) names an entity kind but is in neither SATELLITE_TABLES nor ` +
        `KIND_SCOPED_CONFIG. Decide: does it point AT a record (rewrite it on a move) or ` +
        `does it belong to the INSTANCE (leave it)? Declare it in ${DECL}.`,
    );
  }
  for (const name of phantom) {
    console.error(
      `  ${name} is declared in ${DECL} but no migration defines it with a kind column. ` +
        `Stale entry, or a renamed table the move now silently skips.`,
    );
  }
  for (const b of badColumns) console.error(`  ${b}`);
  process.exit(1);
}

console.log(
  `✓ instance-move-satellites lint: ${seen.size} kind-keyed table(s) accounted for ` +
    `(${satellites.size} rewritten, ${config.size} instance-scoped config)`,
);
process.exit(0);
