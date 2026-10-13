// A line of facts joined with " · ": a card's subtitle, a session's meta line,
// a list of links. Each place used to join its own, so each had to remember
// two things: drop an empty part, so no separator is left hanging, and drop a
// part already said. A scan card for a book remembered the first and not the
// second: the scanned ISBN led the line and the book hit's model number, which
// is the same ISBN, ended it (#6234). lint:meta-lines-join-through-one-door
// holds every such line to this.
import { Children, Fragment, isValidElement, type ReactNode } from "react";

type Part = ReactNode | null | false | undefined;

/** The words a part shows, as a person reads them: a node's text, its
 *  children's in order. */
export function partText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(partText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return Children.toArray(node.props.children).map(partText).join("");
  return "";
}

/** A part's words, case and punctuation aside, as a run of words. */
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");

/** A part already said: its words appear whole in a part shown before it.
 *  "9780596517748" is said by "9780596517748 (read from photo)" and by
 *  "9780596517748."; a part of fewer than four letters or digits ("1", "2L")
 *  is said only by a whole part the same, so a short value is never lost
 *  inside a longer one. */
function alreadySaid(part: string, shown: readonly string[]): boolean {
  if (part.replace(/ /g, "").length < 4) return shown.includes(part);
  return shown.some((s) => ` ${s} `.includes(` ${part} `));
}

/** The parts a line shows: none empty, none repeating one already shown. */
export function distinctParts(parts: ReadonlyArray<Part>): ReactNode[] {
  const shown: string[] = [];
  const out: ReactNode[] = [];
  for (const p of parts) {
    if (p == null || p === false || p === "") continue;
    const w = words(partText(p));
    if (w) {
      if (alreadySaid(w, shown)) continue;
      shown.push(w);
    }
    out.push(p);
  }
  return out;
}

/** The same line as plain text, for a prop that takes a string (a phone
 *  row's subtitle). */
export function joinMeta(parts: ReadonlyArray<string | null | false | undefined>): string {
  return distinctParts(parts).join(" · ");
}

/** The parts joined with " · ", inline: the caller keeps its own wrapper. */
export function MetaParts({ parts }: { parts: ReadonlyArray<Part> }) {
  return (
    <>
      {distinctParts(parts).map((p, i) => (
        <Fragment key={i}>
          {i > 0 && " · "}
          {p}
        </Fragment>
      ))}
    </>
  );
}
