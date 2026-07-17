// When a model's two numbers disagree, and what to do about it.
//
// A serialized model carries `qty` (what you COUNTED) and `units_count` (how
// many serials are ON FILE). They are separate on purpose, and their
// disagreement is information rather than drift: 20 counted with 18 on file
// means two were never scanned. See
// docs/design-decisions/serialized-rollup-and-stock-adjust.md.
//
// The two directions are NOT the same situation, and treating them alike is the
// mistake this module exists to avoid:
//
//   qty > units_count  ("under")  — the EXPECTED state mid-intake. A dealership
//     scanning 40 VINs one at a time reads "40 counted, 1 on file" after the
//     first scan. Prompting there would nag through the exact flow that is
//     fixing it, 39 times. So the gap shows as a passive chip immediately, and
//     only becomes a question once the numbers have STOPPED MOVING.
//   units_count > qty  ("over")   — records exceed reality. Never a normal
//     intermediate state, so it asks immediately.
//
// Pure and dependency-free: the rules are the thing worth testing, and they
// shouldn't need a database to assert.

/** How long a model's units must go untouched before an under-gap is treated as
 *  "intake finished and the numbers still disagree" rather than "you are
 *  mid-scan". Not config and not env: a workspace tuning this would be tuning
 *  how often it gets nagged, which is a symptom, not a setting. */
export const STABILITY_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

export interface ReconcileState {
  /** under: qty > units_count (some not yet scanned). over: units_count > qty
   *  (records exceed reality). */
  direction: "under" | "over";
  qty: number;
  units_count: number;
  /** Have the numbers settled? The prompt waits for this in the `under`
   *  direction; `over` is never a normal intermediate state, so it is always
   *  true there. The chip does not wait for it either way. */
  stable: boolean;
  /** Has the user already answered THIS pair of numbers? Keyed on the pair, so
   *  the same stable disagreement never re-asks, but a genuinely new one does. */
  dismissed: boolean;
}

/** The shape stored at `metadata.reconcile_dismissed` — the exact pair the user
 *  answered about. A bare boolean would mean "never ask about this model again",
 *  which is a different and worse promise. */
export interface DismissedPair {
  qty: number;
  units_count: number;
}

export function parseDismissed(raw: unknown): DismissedPair | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const qty = Number(o.qty);
  const units = Number(o.units_count);
  if (!Number.isFinite(qty) || !Number.isFinite(units)) return null;
  return { qty, units_count: units };
}

/**
 * The reconcile state for one model, or null when there is nothing to say.
 *
 * Null when the model has no units (it is plain stock; `qty` is the whole truth)
 * or when the numbers agree. Both are the overwhelmingly common case, so they
 * cost one comparison.
 */
export function computeReconcile(args: {
  qty: number;
  unitsCount: number;
  /** When the newest unit was paired. Null when there are none. */
  unitsLatestAt: string | null;
  /** The model's `metadata.reconcile_dismissed`, whatever shape it is in. */
  dismissedRaw: unknown;
  now?: Date;
}): ReconcileState | null {
  const { qty, unitsCount, unitsLatestAt, dismissedRaw } = args;
  if (!Number.isFinite(qty) || unitsCount <= 0) return null;
  if (qty === unitsCount) return null;

  const direction: "under" | "over" = qty > unitsCount ? "under" : "over";

  // The window applies to BOTH directions — the signal is "have the units
  // stopped arriving?", not which way the gap points. An earlier version asked
  // immediately in the over-direction on the theory that "more serials than
  // things is never a normal intermediate state"; the serial-first workflow (a
  // fresh part at qty 0 you build up by scanning serials) proved that false —
  // it is over-direction AND plain intake, and prompting mid-scan nags the flow
  // that is fixing it. Direction governs the COPY, never the timing. A genuine
  // double-record surfaces a window later, which beats nagging the common case.
  // See docs/design-decisions/within-instance-units.md.
  const t = unitsLatestAt ? new Date(unitsLatestAt).getTime() : NaN;
  // No usable timestamp: treat as settled rather than never asking. An
  // unaskable prompt is a feature that silently does not exist.
  const stable = !Number.isFinite(t) || (args.now ?? new Date()).getTime() - t >= STABILITY_WINDOW_MS;

  const d = parseDismissed(dismissedRaw);
  const dismissed = !!d && d.qty === qty && d.units_count === unitsCount;

  return { direction, qty, units_count: unitsCount, stable, dismissed };
}

/** What the "use the serials" button posts: a stock movement like any other, so
 *  the consumption ledger can explain it and every wire fires. NOT a silent
 *  column write — a correction nobody can trace is how you get a number nobody
 *  trusts. */
export function adoptUnitsAdjustment(state: ReconcileState): {
  delta: number;
  reason: string;
  source_kind: string;
} {
  return {
    delta: state.units_count - state.qty,
    reason: "Reconciled to units on file",
    source_kind: "reconciliation",
  };
}
