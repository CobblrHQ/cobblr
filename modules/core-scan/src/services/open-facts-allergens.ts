/** What an Open Facts record says a food contains (`allergens_tags`) and may
 *  carry traces of (`traces_tags`), as the plain words a person reads
 *  ("en:sulphur-dioxide-and-sulphites" is "sulphur dioxide and sulphites").
 *
 *  Only the catalog's own English taxonomy is read: a tag in another language
 *  is a contributor's free text, and translating or guessing at it is how an
 *  allergen would be invented. Nothing is inferred from the product's name. A
 *  record that lists none gives an empty list, which the caller leaves off
 *  entirely: "no allergens listed" is not a claim that there are none. */
export function openFactsWords(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const words: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !/^en:[a-z0-9-]+$/.test(tag)) continue;
    const word = tag.slice(3).replace(/-/g, " ").trim();
    if (word && !words.includes(word)) words.push(word);
  }
  return words;
}

/** The `allergens` and `traces` a scan's suggested metadata carries, only
 *  where the catalog supplied them. */
export function allergenMeta(raw: unknown): { allergens?: string[]; traces?: string[] } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const allergens = openFactsWords(p.allergens_tags);
  const traces = openFactsWords(p.traces_tags);
  return { ...(allergens.length ? { allergens } : {}), ...(traces.length ? { traces } : {}) };
}

/** A scan's word list as the text a record keeps ("milk, nuts"), or nothing
 *  when it has none. */
export function wordsOf(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const words = list.filter((w): w is string => typeof w === "string" && w.trim().length > 0);
  return words.length ? words.join(", ") : undefined;
}
