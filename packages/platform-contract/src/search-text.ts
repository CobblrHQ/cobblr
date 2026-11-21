// A word typed into a search, matched the way a person means it (#4115).
//
// A search box on a phone types "creme" for "Crème fraîche" and "cafe" for
// "Café": the keyboard puts no accent in, and nobody goes back for one. A
// filter that compared lowercased text found nothing, so a recipe titled
// "Crème brûlée" could not be found by typing it. Both sides are folded the
// same way: lowercase, accents and other marks gone, and the letters a
// keyboard spells out (ß, æ, œ, ø, ł, đ, þ) written as it does.

const SPELLED: Record<string, string> = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };

/** Text as a search compares it: lowercase, without accents or marks. */
export function foldForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ßæœøłđðþı]/g, (c) => SPELLED[c] ?? c);
}

/** Does `text` hold what was typed, whatever its case and accents? An empty query holds everywhere. */
export function textHas(text: string | null | undefined, query: string): boolean {
  const needle = foldForSearch(query.trim());
  if (!needle) return true;
  return foldForSearch(text ?? "").includes(needle);
}
