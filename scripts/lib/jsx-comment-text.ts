// The rule behind lint:jsx-comment-text, a file at a time, so its shapes are
// pinned by a test (a-comment-in-jsx-never-renders.test.ts).
import ts from "typescript";

/** Does any real content come BEFORE this text, inside the same parent?
 *
 *  This is the whole rule, because `//` in JSX children is usually deliberate
 *  here: section headings are written `// what's here` and styled mono, and
 *  there are ~75 of them. A heading always LEADS its parent - it is the first
 *  thing in the div, and any element after it is the count badge
 *  (`// {g.key} <span>({n})</span>`).
 *
 *  A leaked code comment has the opposite shape. It was written to describe the
 *  markup around it, so it lands AFTER something, which is exactly where it
 *  renders: in the middle of a control. So "something precedes it" separates
 *  the two cleanly, with no list of exceptions to keep. */
function followsContent(text: ts.JsxText): boolean {
  const parent = text.parent;
  if (!parent || !("children" in parent)) return false;
  const children = (parent as ts.JsxElement | ts.JsxFragment).children;
  const i = children.indexOf(text);
  if (i < 0) return false;
  // An EXPRESSION counts, not just an element. The comment that shipped sat
  // after a `{cond ? <img/> : <Thumb/>}` ternary, so an element-only test read
  // it as leading and let it through.
  return children.slice(0, i).some((c) => !ts.isJsxText(c));
}

/** The parent is a component or a fragment, not a styled element: a heading
 *  (`<h3 className="font-mono">// fields</h3>`) sits in markup that draws it,
 *  never straight inside a provider or a fragment, where only code comments
 *  land (#6280: three lines above the camera's shell, inside its provider). */
function inComponentOrFragment(text: ts.JsxText): boolean {
  const parent = text.parent;
  if (ts.isJsxFragment(parent)) return true;
  if (ts.isJsxElement(parent)) return /^[A-Z]/.test(parent.openingElement.tagName.getText());
  return false;
}

/** The text is a code comment, not a mono heading: it follows content, or it
 *  runs to more than one `//` line (a heading is one line), or it sits straight
 *  inside a component or fragment. A `/*` is never a heading. */
export function commentLines(text: ts.JsxText): number[] {
  const lines = text.text.split("\n").map((l) => l.trim());
  const slashed = lines.flatMap((t, i) => (t.startsWith("//") ? [i] : []));
  const block = lines.flatMap((t, i) => (t.startsWith("/*") || t.startsWith("*/") ? [i] : []));
  const asCode = followsContent(text) || slashed.length > 1 || (slashed.length > 0 && inComponentOrFragment(text));
  return [...(asCode ? slashed : []), ...block].sort((a, b) => a - b);
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
