#!/usr/bin/env tsx
// Guard: a migration must not break the api version that is ALREADY DEPLOYED.
//
// WHY THIS IS A LINT: §14.3 has said "additive first, two-phase for breaking
// changes" since the repo started, and nothing enforced it. That was survivable
// only while exactly one api version ever touched a database at a time. The
// canary channel (docs/design-decisions/canary-channel.md) ends that: a
// main-tracking api and the last-promoted api run against the SAME Postgres, so
// the newer one's boot migrations land under the older one's feet - on EVERY
// tenant DB, not just the author's. An additive migration is invisible to the
// old reader. A `DROP COLUMN` takes down every user who has not been promoted
// yet, and they have no idea why.
//
// So the rule this enforces is narrower and more checkable than "be additive":
//
//   A migration may not remove, rename, retype or newly-constrain anything the
//   PREVIOUSLY DEPLOYED api could still be reading or writing.
//
// Adding things is always fine. Loosening (`DROP NOT NULL`) is fine. It is the
// contract half of expand/contract that has to wait for the old readers to go.
//
// ESCAPE HATCH — when the old readers really are gone, say so in the file:
//
//   -- PHASE: contract
//   -- SAFE WHEN: cobblr.me promoted past 2026-08-05; no deployed api selects
//   --            digifab_jobs.farm_printer_id (grep'd api/ + modules/)
//
// Both lines are required. The point is not the ceremony, it is that the person
// dropping the column has to write down the condition they checked, the same way
// `lint:heal-shims` makes a one-shot shim state its own retirement.
//
//   npx tsx scripts/lint-migration-additive.ts   (pnpm run lint:migration-additive)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Migrations that predate this lint (2026-08-05). Merged migrations are
 * immutable (§14.3), so they cannot be annotated after the fact - they are
 * named here instead. This list can only ever SHRINK: a new entry means someone
 * merged a breaking migration without the marker, which is the thing the lint
 * exists to stop.
 */
const GRANDFATHERED = new Set([
  "api/migrations/platform/20260515-006-audit-auth.sql",
  "modules/digifab/migrations/0006_generalize_columns.sql",
  "modules/digifab/migrations/0007_rename_links_table.sql",
  "modules/inventory/migrations/0002_locations_moved_to_core.sql",
]);

interface Rule {
  id: string;
  /** Must be /g — the scanner reads .lastIndex to locate each hit. */
  re: RegExp;
  why: string;
  fix: string;
}

const RULES: Rule[] = [
  {
    id: "drop-column",
    re: /\bdrop\s+column\b/gi,
    why: "the previously-deployed api still SELECTs it",
    fix: "stop reading the column, promote, THEN drop it in a later migration",
  },
  {
    id: "rename-column",
    re: /\brename\s+column\b/gi,
    why: "a rename is a drop plus an add - the old api loses the column instantly",
    fix: "add the new column, dual-write, backfill, switch reads, promote, then drop the old one",
  },
  {
    id: "rename-table",
    re: /\balter\s+table\s+[^\s;]+\s+rename\s+to\b/gi,
    why: "the previously-deployed api still queries the old table name",
    fix: "create the new table + dual-write, or add a view under the old name until the old api is gone",
  },
  {
    id: "drop-table",
    re: /\bdrop\s+table\b/gi,
    why: "the previously-deployed api still queries it",
    fix: "stop querying the table, promote, THEN drop it in a later migration",
  },
  {
    id: "set-not-null",
    re: /\bset\s+not\s+null\b/gi,
    why: "the previously-deployed api INSERTs rows without that column",
    fix: "give the column a DEFAULT and leave it nullable until every writer supplies it",
  },
  {
    id: "alter-column-type",
    re: /\balter\s+column\s+[^\s;]+\s+(?:set\s+data\s+)?type\b/gi,
    why: "the previously-deployed api round-trips the old type and may truncate or fail to parse",
    fix: "add a new column of the new type, dual-write, switch reads, then drop the old one",
  },
  {
    id: "drop-default",
    re: /\bdrop\s+default\b/gi,
    why: "the previously-deployed api relies on the default to INSERT without that column",
    fix: "leave the default until every writer supplies the value explicitly",
  },
];

/**
 * `ADD COLUMN <name> ... NOT NULL` with no DEFAULT. Additive in shape, breaking
 * in effect: the old api's INSERTs do not name the column, so every write fails.
 * GENERATED columns supply their own value, so they are fine.
 */
const ADD_COLUMN = /\badd\s+column\s+(?:if\s+not\s+exists\s+)?"?[\w]+"?\s+([^,;]*)/gi;

export interface Finding {
  line: number;
  rule: string;
  why: string;
  fix: string;
  snippet: string;
}

/**
 * Blank out anything that is not executable SQL, PRESERVING offsets so line
 * numbers stay honest: `--` comments, block comments, string literals and
 * dollar-quoted bodies. Most `DROP COLUMN` text in this repo lives in a
 * "manual recovery if this fails partway" comment header, so stripping is what
 * makes the lint precise enough to be worth having (153 raw grep hits, 7 real).
 *
 * Dollar-quoted bodies are blanked too, so DDL inside a plpgsql function is not
 * seen. That is a deliberate precision/coverage trade: this lint catches the
 * accidental break, not a determined one.
 */
export function stripNonExecutable(sql: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\$\$[\s\S]*?\$\$/g, blank)
    .replace(/'(?:[^'\\\n]|''|\\.)*'/g, blank)
    .replace(/--[^\n]*/g, blank);
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Every deployed-api-breaking statement in one migration's SQL. */
export function findBreakingChanges(sql: string): Finding[] {
  const exec = stripNonExecutable(sql);
  const out: Finding[] = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(exec)) !== null) {
      out.push({
        line: lineOf(exec, m.index),
        rule: rule.id,
        why: rule.why,
        fix: rule.fix,
        snippet: m[0].replace(/\s+/g, " "),
      });
    }
  }

  ADD_COLUMN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ADD_COLUMN.exec(exec)) !== null) {
    const tail = m[1] ?? "";
    if (!/\bnot\s+null\b/i.test(tail)) continue;
    if (/\bdefault\b/i.test(tail) || /\bgenerated\b/i.test(tail)) continue;
    out.push({
      line: lineOf(exec, m.index),
      rule: "add-not-null-no-default",
      why: "the previously-deployed api INSERTs without naming the new column, so every write fails",
      fix: "add a DEFAULT, or add the column nullable and tighten it once every writer supplies it",
      snippet: m[0].replace(/\s+/g, " ").slice(0, 90),
    });
  }

  return out.sort((a, b) => a.line - b.line);
}

/** True when the file declares itself the contract half of an expand/contract. */
export function hasContractMarker(sql: string): boolean {
  return /--\s*PHASE:\s*contract\b/i.test(sql) && /--\s*SAFE\s+WHEN:/i.test(sql);
}

// ── file discovery ───────────────────────────────────────────────────
function sqlFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sqlFilesUnder(p));
    else if (e.name.endsWith(".sql")) out.push(p);
  }
  return out;
}

export function migrationFiles(): string[] {
  const files = sqlFilesUnder(join(ROOT, "api", "migrations"));
  const modulesDir = join(ROOT, "modules");
  if (existsSync(modulesDir)) {
    for (const e of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      files.push(...sqlFilesUnder(join(modulesDir, e.name, "migrations")));
    }
  }
  return files.sort();
}

// ── run ──────────────────────────────────────────────────────────────
function main(): void {
  const files = migrationFiles();
  if (files.length === 0) {
    console.error("[lint:migration-additive] found NO migration files — the glob is broken, which is worse than a red lint.");
    process.exit(1);
  }

  const failures: string[] = [];
  let waived = 0;
  const staleBaseline: string[] = [];

  for (const f of files) {
    const rel = relative(ROOT, f);
    const sql = readFileSync(f, "utf8");
    const findings = findBreakingChanges(sql);

    if (GRANDFATHERED.has(rel)) {
      if (findings.length === 0) staleBaseline.push(rel);
      continue;
    }
    if (findings.length === 0) continue;
    if (hasContractMarker(sql)) {
      waived += findings.length;
      continue;
    }
    for (const d of findings) {
      failures.push(`${rel}:${d.line}  [${d.rule}]  ${d.snippet}\n      why: ${d.why}\n      fix: ${d.fix}`);
    }
  }

  // The baseline may only shrink. An entry that no longer matches means the file
  // changed (merged migrations are immutable) or a rule got narrower — either
  // way the list is lying and should be trimmed.
  if (staleBaseline.length) {
    console.error("[lint:migration-additive] ✗ GRANDFATHERED entries that no longer have any finding — delete them:");
    for (const s of staleBaseline) console.error(`    ${s}`);
    process.exit(1);
  }

  if (failures.length) {
    console.error(`[lint:migration-additive] ✗ ${failures.length} migration change(s) that would break the DEPLOYED api:\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    console.error(
      "  Two api versions run against one Postgres (the canary channel + any staged promote),\n" +
        "  so a migration lands under the previously-promoted api. Additive changes are invisible\n" +
        "  to it; these are not, and they hit EVERY tenant DB, not just yours.\n\n" +
        "  Split it into expand → promote → contract. When the old readers really are gone,\n" +
        "  declare it in the migration and state what you checked:\n\n" +
        "    -- PHASE: contract\n" +
        "    -- SAFE WHEN: <the condition you verified, e.g. cobblr.me promoted past <sha>;\n" +
        "    --            nothing in api/ or modules/ still reads <table>.<column>>\n\n" +
        "  Background: docs/design-decisions/canary-channel.md, CLAUDE.md §14.3.",
    );
    process.exit(1);
  }

  const waiverNote = waived ? `, ${waived} declared contract-phase` : "";
  console.log(
    `[lint:migration-additive] OK — ${files.length} migrations, none break the deployed api` +
      `${waiverNote} (${GRANDFATHERED.size} grandfathered)`,
  );
}

// Importable from the test without running the scan.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
