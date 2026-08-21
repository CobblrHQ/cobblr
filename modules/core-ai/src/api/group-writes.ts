// One sentence, all of its writes: twelve racks are ONE example.
//
// Grouping used to fall back to `${prompt}|${timestamp.slice(0, 16)}` when a
// write carried no turn id — the prompt plus the wall-clock MINUTE. A request
// that happened to straddle :59 → :00 was split into two examples, each a
// fragment, and nothing generalised: the learner saw "two racks" and "two
// racks" instead of "racks 1 through 4", so no {from}/{to} command was derived.
// It failed about one run in four in CI and was written off as flaky.
//
// The intent was never "same minute" — it was "the same request". Rows from one
// request are consecutive and close together; a repeat of the same sentence an
// hour later is a different example. So: same prompt, and no more than a short
// gap from the previous row.

export interface WriteRow {
  turn_id?: string | null;
  prompt?: string | null;
  created_at: string | Date;
}

/** Longer than any single request's writes take to land, shorter than anyone
 *  retyping the same sentence deliberately. */
export const SAME_REQUEST_GAP_MS = 60_000;

/** Group writes into examples. Order of the returned groups follows the order
 *  the requests happened. */
export function groupWritesByRequest<T extends WriteRow>(rows: readonly T[]): T[][] {
  const at = (r: T): number => new Date(r.created_at).getTime();
  // Ascending, so "the gap from the previous row" means what it says. The query
  // hands these over newest-first for the limit, which is not the order the
  // grouping wants.
  const ordered = [...rows].sort((a, b) => at(a) - at(b));

  const byTurn = new Map<string, T[]>();
  const loose: T[] = [];
  for (const r of ordered) {
    if (r.turn_id) {
      const g = byTurn.get(r.turn_id) ?? [];
      g.push(r);
      byTurn.set(r.turn_id, g);
    } else {
      loose.push(r);
    }
  }

  const groups: T[][] = [...byTurn.values()];
  // A turn id is exact. Without one, walk the rows and start a new example when
  // the sentence changes or the trail goes cold.
  let current: T[] = [];
  for (const r of loose) {
    const prev = current[current.length - 1];
    const sameRequest =
      prev != null && (prev.prompt ?? "") === (r.prompt ?? "") && at(r) - at(prev) <= SAME_REQUEST_GAP_MS;
    if (!sameRequest && current.length) groups.push(current);
    current = sameRequest ? [...current, r] : [r];
  }
  if (current.length) groups.push(current);
  return groups.sort((a, b) => at(a[0]!) - at(b[0]!));
}
