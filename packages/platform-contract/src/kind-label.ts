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
