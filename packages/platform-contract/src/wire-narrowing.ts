// Narrowing a wire to the records and the change it is about (#6070).
//
// The owner: "if I scan a particular item, or category/set of items, in this
// case when I subtract a qty by using it up, that it can perform an action
// like send someone a message requesting more." A wire on a stock change ran
// on every change to every record of its kind. Two narrowings, both stored
// in the wire's own `filter`, so the wire engine, its validation, bundles and
// the API carry them with no new machinery:
//
//   WHICH CHANGE  (conditions on the event, `filter.all`)
//     used           the count went down, by any amount
//     ran out        it reached 0 from above
//     below N        it went from N or more to under N
//     reorder point  it reached the record's own minimum from above
//   Each is a CROSSING: the count before the change (event.oldQty) is on the
//   other side of the line from the count after, so a wire fires once per
//   crossing, never again on the next scan already below the line, and again
//   after a restock and the next run-out.
//
//   WHICH RECORDS (`filter.in`)
//     this record, a category, a tag, a saved view; none = the whole
//     collection (what every wire did before).

/** The event a stock record's count changes on. */
export const STOCK_CHANGED_EVENT = "inventory.stock.changed";

export interface NarrowingCondition {
  path: string;
  op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "not_contains" | "empty" | "not_empty";
  value?: string | number | boolean;
  valuePath?: string;
}

export type StockChange =
  | { kind: "any" }
  | { kind: "used" }
  | { kind: "ran-out" }
  | { kind: "below"; n: number }
  | { kind: "reorder-point" };

/** Which records a wire is about. At most one is set; none means every
 *  record of the wire's kind. */
export interface WireRecords {
  /** One record, by id. */
  record?: string;
  /** Records filed under this category, by name. */
  category?: string;
  /** Records carrying this tag. */
  tag?: string;
  /** Records a saved view shows, by the view's id. */
  view?: string;
}

/** The record's own minimum, as a stock record's fields name it. */
export const REORDER_POINT_FIELD = "min_qty";

/** The conditions that say a change of this kind happened. Pure. */
export function stockChangeConditions(change: StockChange): NarrowingCondition[] {
  switch (change.kind) {
    case "any":
      return [];
    case "used":
      return [{ path: "event.delta", op: "lt", value: 0 }];
    case "ran-out":
      return [
        { path: "event.newQty", op: "lte", value: 0 },
        { path: "event.oldQty", op: "gt", value: 0 },
      ];
    case "below":
      return [
        { path: "event.newQty", op: "lt", value: change.n },
        { path: "event.oldQty", op: "gte", value: change.n },
      ];
    case "reorder-point":
      return [
        { path: "event.newQty", op: "lte", valuePath: REORDER_POINT_FIELD },
        { path: "event.oldQty", op: "gt", valuePath: REORDER_POINT_FIELD },
      ];
  }
}

const same = (a: NarrowingCondition, b: NarrowingCondition) =>
  a.path === b.path && a.op === b.op && String(a.value ?? "") === String(b.value ?? "") && (a.valuePath ?? "") === (b.valuePath ?? "");

/** Read a wire's conditions back into the change they say and the
 *  conditions a person added beside it, so an editor shows "ran out" rather
 *  than two rows of paths. Pure. */
export function readStockChange(all: readonly NarrowingCondition[]): { change: StockChange; rest: NarrowingCondition[] } {
  const take = (want: NarrowingCondition[]) => (want.every((w) => all.some((c) => same(c, w))) ? all.filter((c) => !want.some((w) => same(c, w))) : null);
  const reorder = take(stockChangeConditions({ kind: "reorder-point" }));
  if (reorder) return { change: { kind: "reorder-point" }, rest: reorder };
  const out = take(stockChangeConditions({ kind: "ran-out" }));
  if (out) return { change: { kind: "ran-out" }, rest: out };
  const below = all.find((c) => c.path === "event.newQty" && c.op === "lt" && typeof c.value === "number");
  if (below) {
    const rest = take(stockChangeConditions({ kind: "below", n: below.value as number }));
    if (rest) return { change: { kind: "below", n: below.value as number }, rest };
  }
  const used = take(stockChangeConditions({ kind: "used" }));
  if (used) return { change: { kind: "used" }, rest: used };
  return { change: { kind: "any" }, rest: [...all] };
}

/** The records part of a wire's filter, read loosely: one known key with a
 *  non-empty string, or null. Pure. */
export function readWireRecords(raw: unknown): WireRecords | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  for (const key of ["record", "category", "tag", "view"] as const) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) return { [key]: v.trim() };
  }
  return null;
}

/** How a person reads the narrowing: "runs out", "falls below 3",
 *  "is used". Null for any change. */
export function stockChangePhrase(change: StockChange): string | null {
  switch (change.kind) {
    case "any":
      return null;
    case "used":
      return "is used";
    case "ran-out":
      return "runs out";
    case "below":
      return `falls below ${change.n}`;
    case "reorder-point":
      return "falls to its reorder point";
  }
}

// ── A new wire started from elsewhere ──────────────────────────────────
// "When this runs out…" on a record, and the assistant's escort to /wires,
// open the composer with the trigger, the kind and the narrowing chosen. One
// address shape, read and written here, so the button, the escort and the
// page agree on it.

export interface WirePrefillParams {
  kind?: string;
  event?: string;
  change?: StockChange;
  records?: WireRecords | null;
  recordName?: string | null;
}

/** The /wires address that opens the composer prefilled. */
export function wirePrefillHref(p: WirePrefillParams): string {
  const q = new URLSearchParams();
  if (p.kind) q.set("kind", p.kind);
  if (p.event) q.set("event", p.event);
  if (p.change && p.change.kind !== "any") {
    q.set("change", p.change.kind);
    if (p.change.kind === "below") q.set("below", String(p.change.n));
  }
  const r = p.records;
  if (r?.record) q.set("record", r.record);
  if (r?.category) q.set("category", r.category);
  if (r?.tag) q.set("tag", r.tag);
  if (r?.view) q.set("view", r.view);
  if (r?.record && p.recordName) q.set("record_name", p.recordName);
  const s = q.toString();
  return s ? `/wires?${s}` : "/wires";
}

/** The prefill an address carries, or null when it carries none. */
export function wirePrefillFromParams(q: URLSearchParams): WirePrefillParams | null {
  const kind = q.get("kind") ?? undefined;
  const event = q.get("event") ?? undefined;
  const c = q.get("change");
  const n = Number(q.get("below"));
  const change: StockChange | undefined =
    c === "used" || c === "ran-out" || c === "reorder-point"
      ? { kind: c }
      : c === "below" && Number.isFinite(n) && n >= 1
        ? { kind: "below", n }
        : undefined;
  const records: WireRecords | null = (() => {
    for (const key of ["record", "category", "tag", "view"] as const) {
      const v = q.get(key);
      if (v && v.trim()) return { [key]: v.trim() };
    }
    return null;
  })();
  if (!kind && !event && !change && !records) return null;
  return { kind, event, change, records, recordName: q.get("record_name") };
}
