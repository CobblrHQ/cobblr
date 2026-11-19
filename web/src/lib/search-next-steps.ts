// What a search that found nothing offers next (#4115).
//
// A person types what they would say: "hex blot" for a hex bolt. One wrong
// word sank the whole search, and the page said only "Try a different
// keyword". Each word of a search that found nothing is a search of its own
// that may find it ("hex" does), and a long single word is offered by its
// start, since a search matches the start of a word ("screwdirver" finds
// nothing, "scre" finds the screwdriver).

/** The searches to offer when `q` found nothing, in the order it was typed. */
export function shorterSearches(q: string): string[] {
  const text = q.trim();
  if (!text) return [];
  const typed = text.split(/\s+/);
  const words = typed.filter((w) => w.length >= 2);
  const out: string[] = [];
  const add = (s: string) => {
    if (s.toLowerCase() !== text.toLowerCase() && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  if (typed.length > 1) for (const w of words) add(w);
  else if (words.length === 1 && words[0]!.length >= 6) add(words[0]!.slice(0, 4));
  return out.slice(0, 3);
}
