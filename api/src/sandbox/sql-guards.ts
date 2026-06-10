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
