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
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, " "));
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
