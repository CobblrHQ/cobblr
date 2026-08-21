// Adding one more record to what Cobb is talking about.
//
// Pressing a second Cobb head used to REPLACE the first, so "these two racks"
// was impossible to say by pointing — you could tick boxes for it, but the two
// affordances mean different things and only one of them is on a detail page.
// A head is a toggle into the set now: press to add, press again to drop, and
// the chip counts up.
//
// Pure, because the decisions worth arguing about are all in here: what happens
// when the next record is a DIFFERENT kind, how the chip is worded as the set
// grows, and what an empty set leaves behind.

export interface ContextSelection {
  label: string;
  kind?: string;
  ids?: string[];
  text?: string;
}

export interface RecordRef {
  kind: string;
  id: string;
  /** What a person calls this one. */
  label: string;
}

/** "core-locations:location" → "location". The chip needs a word for several
 *  of a thing, and the kind id already carries it. Deliberately not a lookup:
 *  a head must work on a page that has not fetched the kind registry. */
export function nounForKind(kind: string): string {
  const tail = kind.includes(":") ? kind.slice(kind.lastIndexOf(":") + 1) : kind;
  return tail.replace(/[-_]/g, " ").trim() || "record";
}

/** How the chip reads for a set: one is its own name, several are counted. */
export function labelForSet(kind: string, labels: string[]): string {
  if (labels.length === 1) return labels[0]!;
  const noun = nounForKind(kind);
  return `${labels.length} ${noun}${labels.length === 1 ? "" : "s"}`;
}

/**
 * Toggle `record` in `current`, returning what the selection should become.
 *
 * A DIFFERENT kind replaces rather than merges. The chip carries one kind, and
 * an assistant told "these three" where one is a rack and two are parts has to
 * guess which list to look in — a wrong guess there is worse than making you
 * press twice. Same reason a text highlight is replaced rather than appended
 * to: "some words plus two racks" is not a thing anyone means.
 */
export function toggleRecordInContext(
  current: ContextSelection | null,
  record: RecordRef,
): ContextSelection | null {
  const sameKind = current?.kind === record.kind && Array.isArray(current?.ids);
  if (!sameKind) {
    return { label: record.label, kind: record.kind, ids: [record.id], text: record.label };
  }
  const ids = current!.ids!;
  const labels = (current!.text ?? "").split(", ").filter(Boolean);
  const at = ids.indexOf(record.id);
  if (at >= 0) {
    // Dropping the last one leaves nothing, which must be null rather than an
    // empty chip that still says a kind.
    const nextIds = ids.filter((x) => x !== record.id);
    if (nextIds.length === 0) return null;
    const nextLabels = labels.filter((_, i) => i !== at);
    return {
      label: labelForSet(record.kind, nextLabels.length ? nextLabels : nextIds),
      kind: record.kind,
      ids: nextIds,
      text: nextLabels.join(", "),
    };
  }
  const nextIds = [...ids, record.id];
  const nextLabels = [...labels, record.label];
  return {
    label: labelForSet(record.kind, nextLabels),
    kind: record.kind,
    ids: nextIds,
    text: nextLabels.join(", "),
  };
}
