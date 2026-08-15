/** Where a scan item's `ai_notes` line renders on the inbox card.
 *
 *  There are two places it can go and they read very differently:
 *
 *    AMBER  a one-line warning directly under the title, in amber. Loud.
 *    SOURCE the "Source data" box, in muted body text, behind a disclosure.
 *
 *  Routine provenance ("Identified via go-upc.") belongs in the box: it is not
 *  news, and on a closed card it cost a line for nothing. A WARNING ("short
 *  barcode, double-check this is the right product") belongs in amber, because
 *  the whole point is that a triager notices it.
 *
 *  The rule used to be "amber only while the card is CLOSED", on the reasoning
 *  that the Source data box repeats the text once you open it. But that traded
 *  the loud rendering for the quiet one at exactly the moment someone is
 *  looking closely, so opening a card to check a doubtful match made the doubt
 *  less visible (reported 2026-08-14: "I don't think we need to hide the
 *  yellow, that's more visually noticeable"). Expansion does not change how
 *  serious a warning is, so it no longer changes how it is drawn.
 *
 *  Instead the two placements are mutually exclusive: whatever is shown in
 *  amber is not repeated in the box. `never both` is the invariant, and it is
 *  what the tests hold. */

export interface ScanNotesInput {
  /** The item's `ai_notes`, if any. */
  notes: string | null | undefined;
  /** The lookup was rate-limited, so the answer may be thin. */
  rateLimited: boolean;
  /** A short/low-trust barcode: plausible but worth a second look. */
  lowTrust: boolean;
}

export interface ScanNotesPlacement {
  /** Render the amber warning line under the title. */
  amber: boolean;
  /** Render the notes inside the Source data box. */
  sourceBox: boolean;
}

export function scanNotesPlacement({ notes, rateLimited, lowTrust }: ScanNotesInput): ScanNotesPlacement {
  if (!notes) return { amber: false, sourceBox: false };
  const warning = rateLimited || lowTrust;
  return { amber: warning, sourceBox: !warning };
}
