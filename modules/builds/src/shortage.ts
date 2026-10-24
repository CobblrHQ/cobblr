import { quantityNumber } from "@cobblr/platform-contract/quantity-number";
// The one sentence a build short of its components is refused with, said the
// same by the server that refuses it and by the Build button that will not
// press (#5976). Pure, so the page and the engine share it.

export interface ComponentCover {
  name: string;
  available: number;
  per_build: number;
  optional: boolean;
}

const fmt = (n: number) => quantityNumber(n);

/** "Not enough to build 1: Blanks needs 2, 0 in stock.", or null when every
 *  required component covers `qty` builds. An optional one never blocks. */
export function shortageSentence(components: readonly ComponentCover[], qty: number): string | null {
  const short = components
    .filter((c) => !c.optional && c.per_build > 0 && c.per_build * qty > c.available)
    .map((c) => `${c.name} needs ${fmt(c.per_build * qty)}, ${fmt(c.available)} in stock`);
  return short.length ? `Not enough to build ${qty}: ${short.join("; ")}.` : null;
}
