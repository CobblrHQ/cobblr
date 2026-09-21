// The two scanner cards at the top of the dashboard, and the one rule that keeps
// them from contradicting each other.
//
// A fresh workspace with three scans that fit uninstalled bundles used to say
// the same thing three times in three voices: "3 scanned items without a home,
// put them away", a card of install chips ("Groceries · 2"), and the scanner
// lane further down ("2 look like Groceries, create it & file all 2", with the
// person's own photos). Two of the three offered the same one-tap install, and
// the nag counted the very scans its neighbour was offering to file (#3298).
//
// So: the scanner queue owns the install, at the top of the dashboard with the
// person's own photos; the card that summarised it is gone; and the put-away
// nag counts only the scans the queue cannot place.

export interface PutAwayInputs {
  unfiled: number;
  ready: number;
  failedReads: number;
  /** Scans the queue beside this card offers a home (its groups' items).
   *  Zero when the queue is empty. */
  offeredElsewhere: number;
}

/** The sentence parts of the put-away card, or [] when it has nothing to say.
 *  Clamped at zero: the two counts come from two queries that refresh on
 *  their own clocks, so a moment of "3 offered, 2 unfiled" must read as
 *  nothing rather than as minus one. */
export function putAwayParts(i: PutAwayInputs): string[] {
  const unfiled = Math.max(0, i.unfiled - Math.max(0, i.offeredElsewhere));
  const parts: string[] = [];
  if (unfiled > 0) parts.push(`${unfiled} scanned item${unfiled === 1 ? "" : "s"} without a home`);
  if (i.ready > 0) parts.push(`${i.ready} ready to put away`);
  if (i.failedReads > 0) parts.push(`${i.failedReads} receipt${i.failedReads === 1 ? "" : "s"} that couldn't be read`);
  return parts;
}
