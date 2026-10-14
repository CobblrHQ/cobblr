// The rule behind lint:jsx-comment-text, a file at a time, so its shapes are
// pinned by a test (a-comment-in-jsx-never-renders.test.ts).
import ts from "typescript";

/** Every line of this text that is a code comment: any line that opens
 *  with two slashes, or opens or closes a block comment.
 *
 *  This used to spare a one-line `// heading` leading its element, because
 *  ~75 section headings were written that way in the code font. The owner
 *  read them as code in the UI (#6337), they are plain words now, and
 *  lint:section-headings refuses a new one, so a rendered line that opens
 *  with `//` is always somebody's note (#6280: three lines above the camera's
 *  controls, inside its provider). */
export function commentLines(text: ts.JsxText): number[] {
  return text.text
    .split("\n")
    .map((l) => l.trim())
    .flatMap((t, i) => (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*/") ? [i] : []));
}

/** Every line of rendered JSX text in this source that is a code comment. */
export function commentTextIn(file: string, src: string): Array<{ line: number; text: string }> {
  if (!src.includes("//") && !src.includes("/*")) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      // A line of rendered text that STARTS with `//` or `/*` is someone
      // writing a comment. Inside a sentence it is prose (a URL, a ratio) and
      // is left alone.
      const raw = node.text.split("\n");
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      for (const i of commentLines(node)) out.push({ line: line + i + 1, text: raw[i]!.trim().slice(0, 72) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
