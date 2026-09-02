// Which of the two expiry lines a part earns today.
//
// A date gets exactly two notices: a HEADS-UP when it first comes into the
// sweeper's window ("expires in 4d"), and a DAY-OF line the morning it
// actually expires. The sweeper used to keep one ledger row per part and skip
// anything it had already announced, so the day-of never came: the homepage
// said "the cucumbers are expiring today" and nothing did. Pure, so the rule
// can be held to account without a database.

export interface ExpiryStageInput {
  /** The part's expiry, YYYY-MM-DD. */
  expiresOn: string;
  /** Today, YYYY-MM-DD (UTC, the same clock the sweeper's window uses). */
  today: string;
  /** The expires_on the heads-up was last sent for, or null. */
  headsUpSentFor: string | null;
  /** The expires_on the day-of line was last sent for, or null. */
  todaySentFor: string | null;
}

export interface ExpiryStages {
  /** Send the heads-up: this date has not been announced. */
  headsUp: boolean;
  /** Send the day-of line: the date is today or has passed, and this date has
   *  not had its day-of line. */
  today: boolean;
}

export function expiryStages(i: ExpiryStageInput): ExpiryStages {
  const headsUp = i.headsUpSentFor !== i.expiresOn;
  const reached = i.expiresOn <= i.today;
  const today = reached && i.todaySentFor !== i.expiresOn;
  return { headsUp, today };
}
