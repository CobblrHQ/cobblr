// Pure SQL-lexing helpers for the sandbox TENANT_QUERY / TENANT_EXEC
// policy. Extracted from pool.ts so unit tests can import them
// without pulling in worker_threads, the wasm runtime, etc.
//
// The full policy (prefix enforcement + statement-class gating +
// per-query statement_timeout) lives in pool.ts#runTenantQuery and
// is exercised end-to-end by sandbox-read-ops.test.ts via the
// hello-as wasm module. These helpers cover the bypass-resistance
// edge cases (quoted identifiers, multi-statement SQL).

/** Strip surrounding `"` from a Postgres double-quoted identifier
 *  and collapse the `""` → `"` escape. Unquoted identifiers fold to
 *  lower-case (Postgres' default); quoted identifiers preserve case
 *  exactly. */
export function unquoteIdent(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw.toLowerCase();
}

// Clause keywords that end a FROM clause's table list. Anything from a top-
// level FROM up to (but not including) one of these is the table region.
const FROM_BOUNDARY =
  /^(where|group|having|order|limit|offset|union|except|intersect|window|returning|fetch|for|on|join|inner|left|right|full|cross|natural)\b/i;

/** Return the FROM clause's table-list text starting at `start` (just past the
 *  `from` keyword), up to the next clause boundary keyword or an unbalanced
 *  closing paren / semicolon, at paren depth 0. Used to enumerate
 *  comma-separated tables that the single-table FROM/JOIN regex misses. */
export function readFromClause(s: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && ch === ";") break;
    else if (depth === 0 && (i === start || /\W/.test(s[i - 1]!))) {
      // A boundary keyword starting here (and at a word start) ends the list.
      if (FROM_BOUNDARY.test(s.slice(i))) break;
    }
  }
  return s.slice(start, i);
}

/** Split on commas that sit at paren depth 0 (so commas inside a function call
 *  or sub-select don't split a table-list entry). */
export function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Extract the SECOND-and-later tables of every comma-separated FROM list in
 *  a (comment-stripped) statement — the implicit cross-join tables the
 *  single-table FROM/JOIN regex misses. The first table of each FROM is left
 *  to that regex; this returns only the comma siblings, so callers add these
 *  on top. Each result is the leading identifier of a table-list entry, with
 *  schema-qualified entries flagged (they're rejected downstream). */
export function commaListTables(stripped: string): Array<{ raw: string; qualified: boolean }> {
  const out: Array<{ raw: string; qualified: boolean }> = [];
  for (const fm of stripped.matchAll(/\bfrom\b/gi)) {
    const clause = readFromClause(stripped, fm.index! + fm[0].length);
    for (const entry of splitTopLevelCommas(clause).slice(1)) {
      const idm = /^\s*("?[A-Za-z_][A-Za-z0-9_]*"?)(\s*\.\s*("?[A-Za-z_][A-Za-z0-9_]*"?))?/.exec(entry);
      if (!idm) continue;
      if (idm[3]) out.push({ raw: `${unquoteIdent(idm[1]!)}.${unquoteIdent(idm[3])}`, qualified: true });
      else out.push({ raw: unquoteIdent(idm[1]!), qualified: false });
    }
  }
  return out;
}

/** Enumerate the tables of every `USING` clause — the cross-join /
 *  delete-source tables the FROM/JOIN regex misses entirely.
 *
 *  Two `USING` forms exist and only one names tables:
 *    - `DELETE FROM t USING a, b WHERE …`  → a, b ARE tables (enumerate)
 *    - `… JOIN t USING (col, …)`           → a COLUMN list (skip)
 *  We tell them apart by the next non-space char: `(` ⇒ join column
 *  list, anything else ⇒ a table list. Without this, a sandboxed
 *  module could read ANY table in its tenant DB via
 *  `DELETE FROM mymod_t USING secret_table … RETURNING secret_table.*`
 *  — the USING table was never prefix-checked. (Audit 2026-06-19 #1a.)
 */
export function usingTables(stripped: string): Array<{ raw: string; qualified: boolean }> {
  const out: Array<{ raw: string; qualified: boolean }> = [];
  for (const m of stripped.matchAll(/\busing\b/gi)) {
    const after = m.index! + m[0].length;
    let j = after;
    while (j < stripped.length && /\s/.test(stripped[j]!)) j++;
    if (stripped[j] === "(") continue; // JOIN … USING (cols) — not tables
    const clause = readFromClause(stripped, after);
    for (const entry of splitTopLevelCommas(clause)) {
      const idm = /^\s*("?[A-Za-z_][A-Za-z0-9_]*"?)(\s*\.\s*("?[A-Za-z_][A-Za-z0-9_]*"?))?/.exec(entry);
      if (!idm) continue;
      if (idm[3]) out.push({ raw: `${unquoteIdent(idm[1]!)}.${unquoteIdent(idm[3])}`, qualified: true });
      else out.push({ raw: unquoteIdent(idm[1]!), qualified: false });
    }
  }
  return out;
}

/** Read-path (TENANT_QUERY) guard against statements that *look* like a
 *  SELECT but smuggle in a write. The leading-keyword class gate is not
 *  enough: a data-modifying CTE
 *    `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`
 *  passes an `isSelect` check yet executes a DELETE — and combined with
 *  a `reads` grant it turns a read grant into a write. (Audit 2026-06-19
 *  #1b.) Returns a human reason if a forbidden construct is found, else
 *  null. Walks outside single-/double-/dollar-quoted literals so a
 *  column named "into" or a string value '(delete' can't trip it.
 *
 *  Precise by construction:
 *   - INSERT/UPDATE/DELETE/MERGE/TRUNCATE are non-reserved in Postgres
 *     (legal column names), so we flag them ONLY right after `(` — where
 *     a sub-statement begins (a CTE/subquery body), never where a column
 *     reference sits. A subquery proper opens with SELECT, not a DML
 *     verb.
 *   - INTO is reserved, so a bare `INTO` word can only be `SELECT … INTO`
 *     (table creation) — always rejected in read mode. */
export function forbiddenReadConstruct(sqlIn: string): string | null {
  let i = 0;
  const n = sqlIn.length;
  while (i < n) {
    const c = sqlIn[i]!;
    if (c === "'") {
      i++;
      while (i < n) {
        if (sqlIn[i] === "'") {
          if (sqlIn[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sqlIn[i] === '"') {
          if (sqlIn[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlIn.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        i += tag.length;
        const end = sqlIn.indexOf(tag, i);
        if (end < 0) return null; // unterminated; pg will reject anyway
        i = end + tag.length;
        continue;
      }
    }
    if (c === "(") {
      let j = i + 1;
      while (j < n && /\s/.test(sqlIn[j]!)) j++;
      const m = /^(insert|update|delete|merge|truncate)\b/i.exec(sqlIn.slice(j));
      if (m) return `data-modifying '${m[1]!.toLowerCase()}' inside a read query is not allowed (use TENANT_EXEC)`;
      i++;
      continue;
    }
    if ((c === "i" || c === "I") && (i === 0 || /\W/.test(sqlIn[i - 1]!)) && /^into\b/i.test(sqlIn.slice(i))) {
      return "SELECT … INTO is not allowed in a read query";
    }
    i++;
  }
  return null;
}

/** Detect a second statement after the first semicolon. Walks
 *  outside string literals + dollar-quoted blocks so a `;` inside
 *  a TEXT value or a $tag$ block isn't counted. */
export function containsMultipleStatements(sqlIn: string): boolean {
  let i = 0;
  while (i < sqlIn.length) {
    const c = sqlIn[i]!;
    // Single-quoted string. '' is an escape, not a terminator.
    if (c === "'") {
      i++;
      while (i < sqlIn.length) {
        if (sqlIn[i] === "'") {
          if (sqlIn[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Dollar-quoted string $tag$...$tag$.
    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlIn.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        i += tag.length;
        const end = sqlIn.indexOf(tag, i);
        if (end < 0) return false; // unterminated; pg will reject
        i = end + tag.length;
        continue;
      }
    }
    // A semicolon is fine if everything after it is whitespace.
    if (c === ";") {
      const tail = sqlIn.slice(i + 1).trim();
      if (tail.length > 0) return true;
      i++;
      continue;
    }
    i++;
  }
  return false;
}
