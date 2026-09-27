// Does a migration break an api that predates it? The one rule, read by the
// lint (which refuses such a file unless it declares itself the contract half
// of an expand/contract) and by the runner (which records the newest one it
// applied, so an OLDER api sharing the database can tell "a newer build is
// ahead of me, harmlessly" from "a newer build changed what I read"). Two
// copies would drift, so there is one; scripts/lint-migration-additive.ts
// carries the reasoning behind each rule.

export interface Rule {
  id: string;
  /** Must be /g — the scanner reads .lastIndex to locate each hit. */
  re: RegExp;
  why: string;
  fix: string;
}

export const RULES: Rule[] = [
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

