/** The one rule a replay has to obey.
 *
 *  A replay recomputes the DERIVED layer (routing, field-fill, category, catalog
 *  photo) from the perception already stored on the row. It re-asks nobody, so
 *  it can only ever refine what is there. That makes one invariant checkable:
 *
 *      A REPLAY MAY ONLY ADD OR REFINE. It may never empty the candidate list,
 *      and never lower the top candidate's confidence.
 *
 *  This is deliberately a backstop rather than the mechanism. `runMatchmaker`
 *  under replay feeds the STORED candidates through its own refinement, so
 *  confidence is preserved by construction and this guard should almost never
 *  fire. It exists because "almost never" is not "never": every future
 *  derivation pass added to that path inherits the invariant without having to
 *  know about it, which is the difference between fixing the 2026-08-12
 *  downgrade and closing the class.
 *
 *  What it deliberately does NOT police: the item's NAME. A replay cannot reach
 *  the name at all now, and a rename from a real reconciliation is legitimate
 *  outside replay, so that decision lives with the other rename guards in
 *  adopt-name.ts. */

interface HasConfidence {
  confidence?: unknown;
}

const topConfidence = (list: readonly unknown[]): number => {
  const top = list[0] as HasConfidence | undefined;
  return typeof top?.confidence === "number" ? top.confidence : 0;
};

export interface ReplayGuardResult<T> {
  candidates: T[];
  /** Set when the guard had to intervene — worth logging, because it means a
   *  derivation pass tried to regress a row and the invariant caught it. */
  refused: "emptied" | "lowered-confidence" | null;
}

/** Hold a replay's recomputed candidate list to the invariant above. */
export function guardReplayCandidates<T>(stored: readonly unknown[], next: readonly T[]): ReplayGuardResult<T> {
  // Nothing to protect: a row that had no candidates cannot be downgraded.
  if (stored.length === 0) return { candidates: [...next], refused: null };

  if (next.length === 0) return { candidates: stored as T[], refused: "emptied" };

  if (topConfidence(next) < topConfidence(stored)) {
    return { candidates: stored as T[], refused: "lowered-confidence" };
  }

  return { candidates: [...next], refused: null };
}
