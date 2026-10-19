// Reading an object literal in source text by its own braces, not by where
// its closing brace sits: an action in a file of its own (src/actions/,
// #7382) is indented differently from one in module.ts's array.

/** The text inside the braces that open at `open`, strings and comments skipped. Pure. */
export function bracedBody(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i) < 0 ? src.length : src.indexOf("*/", i) + 1;
    else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** The keys of an object literal's body whose values are objects, at its own
 *  level only (an argument's own fields are not arguments). Pure. */
export function topLevelKeys(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && body[i + 1] === "/") { i = body.indexOf("\n", i) < 0 ? body.length : body.indexOf("\n", i); continue; }
    if (c === "/" && body[i + 1] === "*") { i = body.indexOf("*/", i) < 0 ? body.length : body.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\{/.exec(body.slice(i));
      if (m && (i === 0 || /[\s,{]/.test(body[i - 1]!))) {
        out.push(m[1]!);
        i += m[1]!.length - 1;
      }
    }
  }
  return out;
}
