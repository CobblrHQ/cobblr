// Reading a Kysely write out of TypeScript source, well enough to say which
// COLUMNS it sets and what each one is set to.
//
// It lives apart from `scripts/lint-jsonb-array-writes.ts` so it can be tested
// on the shapes that fooled it, which is the only way the two bugs below stay
// fixed. Both were found the day the lint was pointed at the platform schema
// (2026-09-22): it reported four offenders, three of which were correct code.
//
//   - a COMMENT reading "Text + choices: the choices ARE the taxonomy" parsed
//     as an assignment of a watched column
//   - a value continued on the NEXT line was read only to the end of the
//     first line, so the encoding on line two was invisible and a correct
//     writer was called a bug
//
// A lint that cries wolf on a sentence gets switched off, so a false positive
// here costs more than a miss.

/**
 * Blank out comments and string bodies, keeping every character position, so
 * the offsets this file reports are still the real ones.
 *
 * Both halves are load-bearing. A comment reading "Text + choices: the choices
 * ARE the taxonomy" parses as an assignment of a watched column, and a lint
 * that cries wolf on a sentence gets switched off. A string is the same shape
 * ("choices: none") and the same risk.
 */
export function blankNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      // The quotes stay, so `sql`...`` is still recognisable as a tagged
      // template; only the body goes.
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Every object literal that can become a row of column values: the argument of
 * `.values(` / `.set(`, and any `const x = { ... }` that is later spread into
 * one. The second case matters as much as the first - this codebase builds the
 * values object separately and spreads it, which is precisely where the bug
 * this lint exists for was written.
 *
 * A `res.json({...})` body or a `z.object({...})` schema is neither, so the
 * same property name there is correctly ignored.
 */
export function writeRegions(src: string): Array<{ start: number; text: string }> {
  const regions: Array<{ start: number; text: string }> = [];
  const take = (from: number, open: string, close: string) => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === open) depth++;
      else if (src[i] === close) {
        depth--;
        if (depth === 0) {
          regions.push({ start: from, text: src.slice(from, i + 1) });
          return;
        }
      }
    }
  };
  for (const m of src.matchAll(/\.(?:values|set)\s*\(/g)) take(m.index! + m[0].length - 1, "(", ")");
  // `const values = {` / `const row = {` — an object built to be written.
  for (const m of src.matchAll(/\b(?:const|let)\s+\w*[Vv]alues?\w*\s*(?::[^=]+)?=\s*\{/g)) {
    take(m.index! + m[0].length - 1, "{", "}");
  }
  return regions;
}

/**
 * One column's value, from just after its colon to the comma that ends it —
 * across LINES, because this codebase writes the encoded form on the next one:
 *
 *   choices: fd.choices
 *     ? (sql`${JSON.stringify(fd.choices)}::jsonb` as unknown as string[])
 *     : null,
 *
 * Reading to the end of the line saw `fd.choices` and called a correct writer
 * a bug. Three of them, the first time the platform schema was switched on.
 */
export function valueAt(region: string, from: number): string {
  let depth = 0;
  for (let i = from; i < region.length; i++) {
    const c = region[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return region.slice(from, i).trim();
      depth--;
    } else if (c === "," && depth === 0) return region.slice(from, i).trim();
  }
  return region.slice(from).trim();
}

/**
 * Assignments that become COLUMNS of the write.
 *
 * Not simply "depth 1": this codebase adds columns conditionally with
 * `...(cond ? { col: v } : {})`, which nests the key several braces deep while
 * still being a top-level column. A pure depth rule misses exactly that shape -
 * it missed the line this lint was written for.
 *
 * So instead: a key counts unless it sits INSIDE another key's object. That
 * excludes `pre_rerun: { candidates: [...] }` (a property of a value being
 * written into one jsonb column, serialised whole, never at risk) and includes
 * anything reached only through spreads, ternaries and parens.
 */
export function columnAssignments(region: string): Array<{ key: string; value: string; offset: number }> {
  const out: Array<{ key: string; value: string; offset: number }> = [];
  // Each open brace is either a VALUE of some key ("owned") or transparent
  // scaffolding from a spread/ternary.
  const stack: boolean[] = [];
  let lastKey: string | null = null;
  for (let i = 0; i < region.length; i++) {
    const c = region[i]!;
    if (c === "{") {
      // `key: {` means everything inside belongs to that key.
      const before = region.slice(0, i).replace(/\s+$/, "");
      stack.push(before.endsWith(":"));
      lastKey = null;
      continue;
    }
    if (c === "}") {
      stack.pop();
      continue;
    }
    const m = /^([a-z_][a-z0-9_]*)\s*:\s*/i.exec(region.slice(i));
    if (m && (i === 0 || /[\s{,(?:]/.test(region[i - 1]!))) {
      lastKey = m[1]!;
      if (!stack.some(Boolean)) {
        out.push({ key: m[1]!, value: valueAt(region, i + m[0].length), offset: i });
      }
      i += m[1]!.length; // step past the key only; the value may contain braces
    }
  }
  void lastKey;
  return out;
}
