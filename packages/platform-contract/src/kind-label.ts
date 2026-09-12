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
  config?: { item_noun?: unknown } | null;
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
