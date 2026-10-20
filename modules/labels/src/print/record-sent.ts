// What confirming a print records, from what was SENT rather than what the
// queue holds now (#7593). A queue row can change between Send and "Mark
// printed": its copies raised from three to five while the toast was open. The
// paper holds the three that were sent, so those are recorded and the two added
// later stay queued. A row lowered below what was sent, or removed, still had
// the sent copies printed: they are recorded and the row leaves the queue.

/** A queue row as it is now. */
export interface QueuedRow {
  id: string;
  qty: number;
}

/** One row as it was sent: its id and the copies that went to the printer. */
export interface SentItem {
  id: string;
  qty: number;
}

export interface RecordPlan {
  /** Each sent row that is still queued, with the copies to record as printed. */
  printed: Array<{ id: string; qty: number }>;
  /** Rows to keep queued with fewer copies: the ones added after the send. */
  keep: Array<{ id: string; qty: number }>;
  /** Rows whose every copy is now on paper. */
  remove: string[];
}

export function planRecord(rows: readonly QueuedRow[], sent: readonly SentItem[]): RecordPlan {
  const plan: RecordPlan = { printed: [], keep: [], remove: [] };
  const now = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const s of sent) {
    const row = now.get(s.id);
    // Already recorded (a retry) or not this person's row: nothing to do.
    if (!row || seen.has(s.id)) continue;
    seen.add(s.id);
    plan.printed.push({ id: s.id, qty: s.qty });
    if (row.qty > s.qty) plan.keep.push({ id: s.id, qty: row.qty - s.qty });
    else plan.remove.push(s.id);
  }
  return plan;
}
