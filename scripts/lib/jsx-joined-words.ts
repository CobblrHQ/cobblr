// The rule behind lint:jsx-words-never-join, a file at a time, so its shapes
// are pinned by a test (a-word-after-a-jsx-value-keeps-its-space.test.ts).
import ts from "typescript";

/** A `{value}` that renders as text. An element beside a word is left
 *  alone: an icon before a label is spaced by its layout, not by a space. */
const isValue = (n: ts.Node | undefined, side: "end" | "start"): boolean => {
  if (!n || !ts.isJsxExpression(n) || !n.expression) return false;
  const e = n.expression;
  if (ts.isJsxElement(e) || ts.isConditionalExpression(e) || ts.isBinaryExpression(e)) return false;
  // `{" "}` is the space itself.
  if (ts.isStringLiteralLike(e)) return !(side === "end" ? /\s$/ : /^\s/).test(e.text);
  return true;
};

/** Every place in this source where JSX drops the line break between a value
 *  and a word, so the two render joined: `{productName()}` at the end of one
 *  line and `runs in basic mode` on the next renders "Cobblrruns". JSX trims
 *  a text's leading and trailing whitespace when it holds a newline, which is
 *  right beside punctuation and wrong beside a word. */
export function joinedWordsIn(file: string, src: string): Array<{ line: number; text: string }> {
  if (!src.includes("</") && !src.includes("/>")) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const kids = node.children;
      kids.forEach((k, i) => {
        if (!ts.isJsxText(k) || k.containsOnlyTriviaWhiteSpaces) return;
        const raw = k.text;
        const at = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
        // A value, then a new line that starts with a word.
        if (isValue(kids[i - 1], "end") && /^[ \t]*\n\s*[\p{L}\p{N}]/u.test(raw)) out.push({ line: at(k.pos) + 1, text: raw.trim().slice(0, 72) });
        // A line that ends with a word, then a value on the next.
        if (isValue(kids[i + 1], "start") && /[\p{L}\p{N}][ \t]*\n\s*$/u.test(raw)) out.push({ line: at(k.getEnd()) - 1, text: raw.trim().slice(-72) });
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
