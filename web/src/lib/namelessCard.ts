// What the inbox card does with a row that has no name: one rule.
//
// A typed code that resolved to nothing came back titled "Store Item" or
// "Unidentified Item" with an Add button (#2918). The server no longer
// names such a row (adopt-name.ts, guard 0), and this is the card's half:
// a settled row with no name shows the name field in the title's place,
// with the reason underneath. It used to show the field only when the row
// also had NO candidates, so a nameless row the router had given a table
// read "Name this barcode:" with nothing to type into and an Inventory pill
// beside it.
//
// Whether the card may offer a one-tap Add is not decided here any more: the
// platform contract's readiness rule (scan-triage.ts, isScanReadyToFile) is
// read by the pill, File and File N alike, and a nameless row fails it first.
export interface NamelessCardInput {
  status: string;
  suggested_name: string | null;
  /** The lookup has spoken (enrichment finished), whatever it found. */
  ai_suggested_at: string | null | undefined;
  /** A receipt being read is work in progress, never "name it". */
  readingReceipt: boolean;
}

export interface NamelessCardState {
  /** Show the name field in the title's place. */
  nameField: boolean;
}

export function namelessCard(item: NamelessCardInput): NamelessCardState {
  const pending = item.status === "pending";
  const named = !!item.suggested_name?.trim();
  const settled = !!item.ai_suggested_at;
  return {
    nameField: pending && !named && settled && !item.readingReceipt,
  };
}
