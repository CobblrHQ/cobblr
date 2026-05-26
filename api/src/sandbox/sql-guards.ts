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
