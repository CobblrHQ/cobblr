// A question, normalized for matching its wording, with the thing it names
// left intact.
//
// The words around a name ("where is", "how many", "any … left") are English
// and matched in lowercase without punctuation. The name itself can be in any
// script and can carry a hyphen or a decimal point: "日本語 ドライバー",
// "Ключ гаечный", "SER7724-00025", "0.1uF". An ASCII-only expression deleted
// the first two, split the third and read the fourth as "0 1uf", which found
// 1µF, before the search saw them (#7817).

/** Lowercased, punctuation to spaces, whitespace collapsed; letters and
 *  digits of every script kept, a hyphen kept inside a word, and a point or
 *  comma kept between two digits. */
export function normQuestion(s: string): string {
  return keepWords(s.toLowerCase());
}

/** normQuestion without the lowercasing: the name as it was typed, for the
 *  search, which is told exactly what the person asked for. */
export function keepWords(s: string): string {
  return s
    .replace(/[^\p{L}\p{M}\p{N}'\s.,-]+/gu, " ")
    .replace(/-(?![\p{L}\p{N}])|(?<![\p{L}\p{M}\p{N}])-/gu, " ")
    .replace(NOT_A_DECIMAL_POINT, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a value, in any script: what a lookup compares. */
export function wordsOf(s: string): string[] {
  return s.toLowerCase().split(/(?:[^\p{L}\p{M}\p{N}'.,]|(?<!\p{N})[.,]|[.,](?!\p{N}))+/u).filter(Boolean);
}

const NOT_A_DECIMAL_POINT = /(?<!\p{N})[.,]|[.,](?!\p{N})/gu;
