// What a filing still owes the record it made (#7145). Confirm creates an
// arrival's record at the count without its lots, then adds the lotted units
// through the record's own action. When that action refuses (its module was
// turned off a moment before), the record exists and holds none of them. The
// scan was marked filed anyway, and could not be filed again. Now the row
// stays pending with what is owed, and Confirm again finishes on the same
// record: one record, its scanned count and lots, however many tries.

export const FILING_OWED_KEY = "filing_owed";

export interface FilingOwed {
  kind: string;
  entity_id: string;
  count: number;
  refused: string | null;
}

/** The owed filing stamped on a row, or null. Pure. */
export function filingOwedOf(meta: unknown): FilingOwed | null {
  const o = ((meta ?? {}) as Record<string, unknown>)[FILING_OWED_KEY] as Partial<FilingOwed> | undefined;
  if (!o || typeof o.kind !== "string" || typeof o.entity_id !== "string") return null;
  return { kind: o.kind, entity_id: o.entity_id, count: typeof o.count === "number" ? o.count : 0, refused: typeof o.refused === "string" ? o.refused : null };
}

/** Whether a Confirm resumes on the owed record rather than making a new
 *  one: only for the kind it is filing into, and only while that record is
 *  still there (gone, the filing starts over). Pure. */
export function resumesOn(owed: FilingOwed | null, kind: string, stillThere: boolean): boolean {
  return !!owed && owed.kind === kind && stillThere;
}

/** What a refused lot step leaves: the stamp on the row and the answer the
 *  person reads. Never a success. Pure. */
export function owedAfterRefusal(a: { kind: string; entityId: string; title: string; count: number; refused: string | null }): {
  stamp: Record<string, FilingOwed>;
  error: { code: "stock_not_added"; message: string; entity_id: string };
} {
  return {
    stamp: { [FILING_OWED_KEY]: { kind: a.kind, entity_id: a.entityId, count: a.count, refused: a.refused } },
    error: {
      code: "stock_not_added",
      message: `${a.title} is made, but its ${a.count} could not be added (${a.refused ?? "refused"}). Confirm again to add them.`,
      entity_id: a.entityId,
    },
  };
}
