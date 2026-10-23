// What a saved view's rows are NOT, said once for every surface that shows
// them.
//
// A filter the collection could not run comes back as `unapplied` beside
// the rows, and the app says so above them. The MCP reader returned the same
// rows with no word of it, so an assistant presented everything as the
// filtered set (#7880). One sentence, here, that the pages and the reader
// both print.

/** A filter the collection could not run, as the data route returns it. */
export interface UnappliedFilter {
  col: string;
  op: string;
  value?: unknown;
  ref_col?: string | null;
}

/** "One filter in this view could not run, so these are not narrowed by
 *  finish != Gloss.", or null when every filter ran. */
export function unappliedSentence(unapplied: readonly UnappliedFilter[] | null | undefined): string | null {
  if (!unapplied?.length) return null;
  const what = unapplied.map((p) => `${p.col} ${p.op} ${p.ref_col ?? String(p.value ?? "")}`).join(", ");
  return `${unapplied.length === 1 ? "One filter" : `${unapplied.length} filters`} in this view could not run, so these are not narrowed by ${what}.`;
}
