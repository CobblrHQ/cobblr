// Guard: a table named in code must be a table some migration creates.
//
// The trap is that naming a table that does not exist usually fails loudly, and
// exactly once it did not. Backup asked whether the tenant had a `core_files`
// table so it could collect uploaded files as blobs. There has never been such
// a table - core-files prefixes with `core_files_`, so its files table is
// `core_files_files` - and the check was a plain `includes`, so the answer was
// simply "no". Every backup ever taken carried ZERO uploaded files, the real
// table fell through to the generic row dump, and a restore came back looking
// complete with every photo broken. Nothing threw, no test failed, and the
// archive was a valid zip the whole time.
//
// So: collect every table any migration creates, then check the literals code
// hands to Kysely against that list. A typo becomes a failed lint instead of a
// feature that quietly does nothing.
//
// Run: npx tsx scripts/lint-table-names-exist.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CODE_ROOTS = ["api/src"];
const MIGRATION_ROOTS = ["api/migrations", "modules"];

/** Kysely's table-taking builders, with a literal. */
const TABLE_CALL = /\.(selectFrom|insertInto|updateTable|deleteFrom)\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;
/** ...and with a CONSTANT, which is how a careful author writes it.
 *
 *  This half was added because the lint missed its own founding bug: fixing
 *  backup meant hoisting the name into `const FILES_TABLE = "…"`, and a
 *  literal-only matcher then saw nothing at all. A guard that stops seeing the
 *  thing the moment somebody tidies the code is worse than no guard, because it
 *  reports green. */
const TABLE_CALL_IDENT = /\.(selectFrom|insertInto|updateTable|deleteFrom)\(\s*([A-Z][A-Z0-9_]*)\s*\)/g;
/** `const NAME = "some_table";` — resolved within the same file. */
const CONST_STR = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([a-z][a-z0-9_]*)["'`]/g;
/** `create table [if not exists] [schema.]name` in any migration. */
const CREATE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z0-9_]+\.)?["']?([a-z][a-z0-9_]*)["']?/gi;
/** Renames land as a new name nothing else creates. */
const RENAME = /alter\s+table\s+[^\s;]+\s+rename\s+to\s+["']?([a-z][a-z0-9_]*)["']?/gi;

function walk(dir: string, test: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(full)) out.push(full);
  }
  return out;
}

function knownTables(): Set<string> {
  const known = new Set<string>();
  for (const root of MIGRATION_ROOTS) {
    for (const f of walk(root, (p) => p.endsWith(".sql"))) {
      const sql = readFileSync(f, "utf8");
      for (const m of sql.matchAll(CREATE)) known.add(m[1]!.toLowerCase());
      for (const m of sql.matchAll(RENAME)) known.add(m[1]!.toLowerCase());
    }
  }
  return known;
}

function main(): void {
  const known = knownTables();
  if (known.size < 50) {
    console.error(`✗ only found ${known.size} tables in migrations — the scan is broken, not the code`);
    process.exit(1);
  }

  const problems: string[] = [];
  for (const root of CODE_ROOTS) {
    for (const file of walk(root, (p) => /\.ts$/.test(p) && !p.endsWith(".d.ts") && !p.includes(".test."))) {
      const body = readFileSync(file, "utf8");
      // Constants first, so an identifier handed to selectFrom can be resolved.
      const consts = new Map<string, string>();
      for (const m of body.matchAll(CONST_STR)) consts.set(m[1]!, m[2]!.toLowerCase());

      body.split("\n").forEach((line, i) => {
        const named: string[] = [];
        for (const m of line.matchAll(TABLE_CALL)) named.push(m[2]!.toLowerCase());
        for (const m of line.matchAll(TABLE_CALL_IDENT)) {
          const resolved = consts.get(m[2]!);
          if (resolved) named.push(resolved);
        }
        for (const name of named) {
          if (known.has(name)) continue;
          problems.push(
            `  ${file}:${i + 1}  "${name}" is not created by any migration\n      ${line.trim().slice(0, 100)}`,
          );
        }
      });
    }
  }

  if (problems.length > 0) {
    console.error(`✗ table names that no migration creates:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`✓ table names: every table code queries is created by a migration (${known.size} known)`);
}

main();
