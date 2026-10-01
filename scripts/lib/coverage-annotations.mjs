// What a test file says it covers in the coverage matrix (#4286), so CI's own
// tests fill in their cells: the role matrix, the guest reads, the field
// scopes. One line per claim, anywhere in the file:
//
//   // COVERAGE: <surface or glob> <dimension>[,<dimension>...]
//   // COVERAGE: kind:* guest              every kind's pages, as a guest
//   // COVERAGE: route:/search member      the search page, as a member
//
// A glob's `*` matches any run of characters. A claim is expanded only onto
// rows the dimension applies to. lint:coverage-surfaces refuses a claim that
// names no row or an unknown dimension, so a typo never reads as coverage.

const LINE = /^\s*\/\/\s*COVERAGE:\s*(\S+)\s+(\S+)\s*$/;

/** The raw claims in one file's source: [{surface, dimensions, line}]. */
export function claimsIn(src) {
  const out = [];
  src.split("\n").forEach((l, i) => {
    const m = LINE.exec(l);
    if (m) out.push({ surface: m[1], dimensions: m[2].split(",").filter(Boolean), line: i + 1 });
  });
  return out;
}

const globRe = (g) => new RegExp(`^${g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/**
 * Expand claims onto the matrix's rows.
 * @returns {{ pairs: Array<{surface: string, dimension: string}>, problems: string[] }}
 */
export function expandClaims(claims, rows) {
  const dims = new Set(rows.dimensions.map((d) => d.id));
  const pairs = [];
  const problems = [];
  for (const c of claims) {
    const re = globRe(c.surface);
    const hit = rows.surfaces.filter((s) => re.test(s.id));
    if (!hit.length) problems.push(`line ${c.line}: ${c.surface} names no row of the coverage matrix`);
    for (const d of c.dimensions) {
      if (!dims.has(d)) {
        problems.push(`line ${c.line}: ${d} is not a dimension (${[...dims].join(", ")})`);
        continue;
      }
      const applies = hit.filter((s) => !s.applicable || s.applicable.includes(d));
      if (hit.length && !applies.length) problems.push(`line ${c.line}: ${d} applies to none of the rows ${c.surface} names`);
      for (const s of applies) pairs.push({ surface: s.id, dimension: d });
    }
  }
  return { pairs, problems };
}
