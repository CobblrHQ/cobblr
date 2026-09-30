// What a KIND is called on screen, answered once.
//
// A saved view printed its kind id and renderer as chips: `bookshelf:item`,
// `groceries:item`, GALLERY, VENDING. The pinned panel printed INVENTORY:PART
// beside a part, and a bin's adjust sheet said "only part in this bin" about
// a book (the 2026-09-12 new-user review). Each surface had reached for the
// raw identifier because nothing offered the word. A kind id is a routing key;
// the person sees a collection, and a collection has a name and a noun.
//
// The rules are pure and read the workspace's instances (display name,
// declared item noun) so a bundle's own words are what appear. A kind with no
// instance behind it (`inventory:part`, `assets:asset`) reads by its type
// suffix, humanised, which is what the module calls the thing.
// Buildless subpath: node resolves this file as-is, so no runtime import of a
// sibling (the exports map is the only door). The noun fallback below is the
// same rule plural.ts's itemNounFor states, kept in step by kind-label.test.

export interface InstanceForLabel {
  instance_name: string;
  display_name?: string | null;
  module_name?: string | null;
  config?: { item_noun?: unknown; item_noun_plural?: unknown } | null;
}

/** The instance a kind belongs to (`vehicles:item` -> the vehicles instance),
 *  or null for a plain module kind. */
export function instanceForKind<T extends InstanceForLabel>(
  kind: string | null | undefined,
  instances: readonly T[] | null | undefined,
): T | null {
  const [head, tail] = (kind ?? "").split(":");
  if (!head || tail !== "item") return null;
  return instances?.find((i) => i.instance_name === head) ?? null;
}

function humanise(s: string): string {
  const w = s.replace(/[_-]/g, " ").trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : w;
}

/** The collection's name for a kind: "Bookshelf" for `bookshelf:item`, "Part"
 *  for `inventory:part`. Never the id. */
export function collectionLabelFor(
  kind: string | null | undefined,
  instances: readonly InstanceForLabel[] | null | undefined,
): string {
  const inst = instanceForKind(kind, instances);
  if (inst?.display_name?.trim()) return inst.display_name.trim();
  const tail = (kind ?? "").split(":")[1]?.trim();
  if (tail && tail !== "item") return humanise(tail);
  const head = (kind ?? "").split(":")[0]?.trim();
  return head ? humanise(head) : "Item";
}

/** The collection a RECORD belongs to. A record in a named collection comes
 *  back under its module's base kind with `instance` set (a grocery is an
 *  `inventory:part` in the "groceries" instance), so labelling it by `kind`
 *  alone called a jar of Nutella a "Part" in a pantry (#4146). */
export function collectionLabelForRecord(
  record: { kind: string; instance?: string | null },
  instances: readonly InstanceForLabel[] | null | undefined,
): string {
  return collectionLabelFor(record.instance ? `${record.instance}:item` : record.kind, instances);
}

/** One thing in that collection: "book" for `bookshelf:item` when the
 *  instance declares it, "part" for `inventory:part`. */
export function itemNounForKind(
  kind: string | null | undefined,
  instances: readonly InstanceForLabel[] | null | undefined,
): string {
  const inst = instanceForKind(kind, instances);
  const declared = inst?.config?.item_noun;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  const tail = (kind ?? "").split(":")[1]?.trim();
  // "item" is the literal suffix every instance kind carries (`vehicles:item`),
  // so it tells us nothing the fallback does not already say.
  if (tail && tail !== "item") return tail.replace(/[_-]/g, " ");
  return "item";
}

/** Several of that thing: the collection's own plural when it declares one
 *  (a Contacts table whose noun is "person" says "people"), else what the
 *  caller makes of the singular. The caller supplies the rule because this
 *  file is buildless and imports no sibling; the web passes the contract's
 *  pluralise. A surface that pluralised the noun itself ("No matching
 *  persons") ignored the word the person chose in Presentation. */
export function itemNounPluralForKind(
  kind: string | null | undefined,
  instances: readonly InstanceForLabel[] | null | undefined,
  pluralise: (noun: string) => string,
): string {
  const inst = instanceForKind(kind, instances);
  const declared = inst?.config?.item_noun_plural;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  return pluralise(itemNounForKind(kind, instances));
}

// ─── A kind in a sentence, from the workspace's kinds list ────────────────
//
// An action handler's summary is the sentence a person reads on the card
// after Do it, and seven of them wrote the kind id into it: `"Colour" (text)
// added to inventory:part`, `"Spices" created, its records are spices:item`
// (walked on the rig 2026-09-20, #3237). The handlers hold the workspace's
// kinds list (listKindsForOrg), which already carries the words: a module
// kind's registry name and plural, an instance kind's chosen name. So one
// rule over that list, and the sentence says "on parts" and "Spices".

export interface KindForWords {
  id: string;
  display_name?: string | null;
  display_name_plural?: string | null;
  /** Set on a kind synthesised from a workspace instance (`spices:item`). */
  instance_name?: string | null;
}

export interface KindWords {
  /** One of them, mid-sentence: "part", "machine", "Spices" (an instance's
   *  chosen name is a proper name and keeps its case). */
  one: string;
  /** Several, mid-sentence: "parts", "machines", "Spices". */
  many: string;
}

const naivePlural = (w: string): string => (/(s|x|z|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);

/** The words a sentence uses for a kind. A module kind reads by its registry
 *  name, lowercased for the middle of a sentence; an instance kind reads by
 *  the name the person gave it, as given. A kind the list does not hold reads
 *  by its type suffix, humanised, never by its id. */
export function kindWordsFrom(
  kind: string | null | undefined,
  kinds: readonly KindForWords[] | null | undefined,
  pluralise: (noun: string) => string = naivePlural,
): KindWords {
  const row = kinds?.find((k) => k.id === kind) ?? null;
  if (row?.instance_name && row.display_name?.trim()) {
    const name = row.display_name.trim();
    return { one: name, many: row.display_name_plural?.trim() || name };
  }
  if (row?.display_name?.trim()) {
    const one = row.display_name.trim().toLowerCase();
    return { one, many: (row.display_name_plural?.trim() || pluralise(one)).toLowerCase() };
  }
  const tail = (kind ?? "").split(":")[1]?.trim();
  const head = (kind ?? "").split(":")[0]?.trim();
  // An instance kind the list does not hold: its slug names the collection
  // already ("spices"), one word for one and for many.
  if (tail === "item" && head) return { one: head.replace(/[_-]/g, " "), many: head.replace(/[_-]/g, " ") };
  const one = (tail || head || "record").replace(/[_-]/g, " ").toLowerCase();
  return { one, many: pluralise(one) };
}

/** The plain word for a view renderer. The id names an implementation; the
 *  word names what the person sees. */
export const VIEW_TYPE_LABELS: Record<string, string> = {
  list: "List",
  table: "Table",
  kanban: "Board",
  trend: "Trend",
  calendar: "Calendar",
  gantt: "Timeline",
  gallery: "Gallery",
  heatmap: "Heatmap",
  vending: "Cards",
};

export function viewTypeLabel(viewType: string | null | undefined): string {
  const t = (viewType ?? "").trim().toLowerCase();
  return VIEW_TYPE_LABELS[t] ?? humanise(t || "view");
}

// ─── The re-buy answers, in the kind's own words ──────────────────────────
//
// "You already have one of these, and you just scanned another" has three
// answers, and their words come from what the collection WEARS, never from
// the component: a bookshelf offered "Replaced the one that ran out", "+1,
// still had some" and "Old one went bad" for a second copy of The Hobbit
// (the 2026-09-13 blank-account review). Stock is counted and consumed, so
// the pantry words; one of a thing (a book, a tool, a vehicle) is kept, so a
// second one is another copy and a replacement is the same book again. Waste
// is a verb only where the face says the thing goes off.

/** The two faces that decide the words, read off the faces verdict. */
export interface RepurchaseFace {
  /** Counted and consumed (the `stock` face). */
  stock: boolean;
  /** Goes off (the `perishable` face). */
  perishable: boolean;
}

export interface RepurchaseWord {
  label: string;
  title: string;
}

export interface RepurchaseWords {
  /** The everyday re-buy; null when there is nothing to have replaced. */
  replace: RepurchaseWord | null;
  /** More of the same, on top of what is there. */
  add: RepurchaseWord;
  /** The old one is waste; null where the face says the thing does not spoil. */
  wentBad: RepurchaseWord | null;
  /** Whether the ledger's "~N days of the last one left" line applies. */
  ledgerLine: boolean;
}

/** The words for one match: `noun` is the collection's ("book"), `quantity`
 *  what the scan adds, `hasSome` whether the record still holds any. */
export function repurchaseWords(face: RepurchaseFace, noun: string, quantity: number, hasSome: boolean): RepurchaseWords {
  const n = Math.max(1, Math.trunc(quantity));
  const thing = noun.trim() || "one";
  if (face.stock) {
    return {
      replace: hasSome
        ? {
            label: "Replaced the one that ran out",
            title: "The one you had ran out; this is the new one. The count stays what you scanned, and the ledger learns how long the last one lasted.",
          }
        : null,
      add: {
        label: `+${n}${hasSome ? ", still had some" : " to it"}`,
        title: hasSome ? "You still have the old one; this goes on top." : "",
      },
      wentBad:
        hasSome && face.perishable
          ? { label: "Old one went bad", title: "The old one went bad and this replaces it. Recorded as waste, never as consumption." }
          : null,
      ledgerLine: true,
    };
  }
  return {
    replace: hasSome
      ? {
          label: `Same ${thing}, replacing the old one`,
          title: `The ${thing} you had is gone and this one takes its place: one record, the count stays what you scanned.`,
        }
      : null,
    add: {
      label: n === 1 ? "Another copy" : `${n} more copies`,
      title: hasSome ? `You keep the ${thing} you have; this one joins it on the same record.` : `The first ${thing} on this record.`,
    },
    wentBad:
      hasSome && face.perishable
        ? { label: "The old one went bad", title: "The old one went bad and this takes its place. Recorded as waste, never as use." }
        : null,
    ledgerLine: false,
  };
}

/** The three answers to "you already have one of these": the one list the
 *  card's buttons, the File everything select, the plan line's sentence and
 *  the server's `seen[].restock` all speak. */
export const RESTOCK_CHOICES = ["add", "replaced", "went_bad"] as const;
export type RestockChoice = (typeof RESTOCK_CHOICES)[number];

/** The count a record holds after filing `bought` onto it with this choice,
 *  or null when what it holds now is not known. Adding goes on top; a
 *  replacement (the old one ran out, or went bad) leaves exactly what was
 *  bought, the way the attach's replace mode does. */
export function restockOutcome(choice: RestockChoice, have: number | null | undefined, bought: number): number | null {
  const n = Math.max(1, Math.trunc(bought));
  if (choice === "add") return have == null ? null : have + n;
  return n;
}

const RESTOCK_WHY: Record<RestockChoice, string | null> = {
  add: null,
  replaced: "the old one ran out",
  went_bad: "the old one went bad",
};

/** What filing this line will do, in words, from the same choice that files
 *  it: "Whole milk: 1 → 2", "Replace Sourdough loaf: 2 → 1 (the old one went
 *  bad)". The line said "+1 to …" whatever was chosen (#3709). */
export function restockSentence(choice: RestockChoice, title: string, have: number | null | undefined, bought: number): string {
  const n = Math.max(1, Math.trunc(bought));
  const to = restockOutcome(choice, have, n);
  const why = RESTOCK_WHY[choice];
  if (!why) return have == null ? `+${n} to ${title}` : `${title}: ${have} → ${to}`;
  return `Replace ${title}: ${have == null ? "" : `${have} `}→ ${to} (${why})`;
}


// ─── The word the person picked for their things (#3650) ──────────────────
//
// A bundle can offer more than one word for what its table holds or counts
// (Yarn: ball, skein or hank). Its labels, help and action text say
// {{noun}} / {{nouns}} (or {{Noun}} / {{Nouns}} to start a sentence), and the
// install fills them with the word chosen, so every screen, Cobb and every
// export read the same word. `of` says what the word names: "unit" is what
// records count in (Yarn's ball; records follow a change, the way the
// skein-to-ball rename moved them), "item" is one record ("book" or "title").
// The choice is stored on the instance (`noun_choice`); absent means the
// bundle's default, so a workspace that never chose needs nothing healed.

export interface NounWords {
  singular: string;
  plural: string;
}

export interface NounChoiceDecl extends NounWords {
  of: "unit" | "item";
  /** Other words the person may pick instead of the default. */
  alternatives: NounWords[];
}

/** Every word on offer, the bundle's default first, each once. */
export function nounOptions(decl: NounChoiceDecl): NounWords[] {
  const out: NounWords[] = [];
  for (const w of [{ singular: decl.singular, plural: decl.plural }, ...(decl.alternatives ?? [])]) {
    if (!out.some((o) => o.singular.toLowerCase() === w.singular.toLowerCase())) out.push({ singular: w.singular, plural: w.plural });
  }
  return out;
}

/** The word in force: the stored choice when it is one on offer, else the
 *  default. A stale or foreign value never leaks onto a screen. */
export function chosenNoun(decl: NounChoiceDecl, stored: unknown): NounWords {
  const opts = nounOptions(decl);
  const s = stored as { singular?: unknown } | null | undefined;
  const want = typeof s?.singular === "string" ? s.singular.toLowerCase() : "";
  return opts.find((o) => o.singular.toLowerCase() === want) ?? opts[0]!;
}

/** The names a table answers to besides the one it shows: every word its
 *  offer lists, so a Supplies table that also offers "notions" is found by
 *  someone who calls them notions, and a Yarn table by "skeins". The label
 *  itself is left out; each name once, capitalised. */
export function tableOtherNames(label: string, decl: NounChoiceDecl | null | undefined): string[] {
  if (!decl) return [];
  const cap = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);
  const out: string[] = [];
  for (const w of nounOptions(decl)) {
    for (const name of [cap(w.plural), cap(w.singular)]) {
      if (name.toLowerCase() !== label.toLowerCase() && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  }
  return out;
}

const NOUN_TOKEN = /\{\{\s*(noun|nouns|Noun|Nouns)\s*\}\}/g;

/** Whether a string carries a noun token. */
export function hasNounToken(text: string): boolean {
  NOUN_TOKEN.lastIndex = 0;
  return NOUN_TOKEN.test(text);
}

/** A bundle string with its noun tokens filled. */
export function fillNoun(text: string, noun: NounWords): string {
  const cap = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);
  return text.replace(NOUN_TOKEN, (_m, t: string) =>
    t === "noun" ? noun.singular : t === "nouns" ? noun.plural : t === "Noun" ? cap(noun.singular) : cap(noun.plural),
  );
}
