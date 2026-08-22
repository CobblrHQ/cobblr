// The three things every "one way to do this" lint kept re-implementing.
//
// Before this, each such script carried its own copy of stripComments (four
// identical copies), and two carried their own JSX opening-tag scanner. Those
// copies are how a lint quietly stops matching what it thinks it matches - the
// scan-session-header lint spent a day matching its OWN comment prose because
// its file-local stripComments was applied one call too late.

/** Blank comments length-preservingly, so line numbers survive and a lint can
 *  never match its own explanatory prose (a real failure, 2026-08-02). */
export function stripComments(src: string): string {
  // A scanner, not two regexes, because the regex pair could not tell where a
  // comment STARTS. It replaced block comments first, unaware of strings and of
  // line comments, so a `/*` inside either opened a comment that ran to the next
  // `*/` anywhere in the file and blanked every line between.
  //
  // One `//     (accept=image/*)` near the top of ScanPage.tsx swallowed its
  // entire import block and 419 lines of code, and 660 lines across the files
  // the capability rules watch were invisible the same way - so those rules
  // reported clean over code they had never looked at (2026-08-22).
  //
  // Comment bytes become spaces and newlines are kept, so every line number and
  // column stays where it was.
  let out = "";
  let state: "code" | "line" | "block" | "string" | "template" = "code";
  let quote = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'") { state = "string"; quote = c; out += c; i += 1; continue; }
      if (c === "`") { state = "template"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; i += 1; continue; }
      out += " "; i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i += 1; continue;
    }
    // Inside a string or template: an escape consumes the next character, so a
    // `\"` never ends the run and a `\`` never ends a template.
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (state === "string" && (c === quote || c === "\n")) { state = "code"; out += c; i += 1; continue; }
    if (state === "template" && c === "`") { state = "code"; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

/** A quoted run and its inner text, for telling a control LABEL from prose. */
export function stringLiterals(line: string): string[] {
  return (line.match(/(["'`])((?:\\.|(?!\1).)*)\1/g) ?? []).map((l) => l.slice(1, -1));
}

/**
 * Every JSX opening tag for `component`: from `<Name` to the `>` that closes the
 * opening tag. Quote- and brace-aware, so a `>` inside a prop expression
 * (`onClick={() => x}`) does not end the tag early.
 */
export function openingTags(src: string, component: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = new RegExp(`<${component}(?![A-Za-z0-9_])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, text: src.slice(m.index, i) });
  }
  return out;
}
