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
 *  what the tests hold.
 *
 *  Once a person has said "Looks fine" (`reviewed`), the warning is spent: the
 *  point of that override is to stop nagging, so the note stops shouting in
 *  amber and drops to the muted box like ordinary provenance. Without this a
 *  low-trust barcode kept its amber line AFTER review — and because clearing
 *  the review flag also removes the "Looks fine" action, the warning became a
 *  problem the reporter could no longer dismiss (feedback 29a2515b).
 *
 *  Whether a doubt is still open is the contract's call (scan-triage's
 *  scanDoubt: pending, low_trust, not reviewed), never a raw read of the
 *  flag here (#3057). A short-barcode doubt is rendered from that state as
 *  its own amber sentence (scanDoubtWords) while the note, provenance only,
 *  sits in the box; a split's doubt lives in the note's own words, so the
 *  note is the amber line. */

import type { ScanDoubt } from "@cobblr/platform-contract/scan-triage";

export interface ScanNotesInput {
  /** The item's note as provenance (scanProvenanceNote: the doubt the lookup
   *  once baked in is already stripped), if any. */
  notes: string | null | undefined;
  /** The lookup was rate-limited, so the answer may be thin. */
  rateLimited: boolean;
  /** The identify step could not name the photo and said why (the row's
   *  coded `identify_failure`, #2916): the note IS the reason, and a reason
   *  behind a disclosure is a reason nobody reads. */
  identifyFailed?: boolean;
  /** A person pressed "Looks fine": the review flag is cleared and so is the
   *  action that clears it, so a lingering amber warning can no longer be
   *  dismissed. A reviewed note is never a warning — it drops to the box. */
  reviewed?: boolean;
  /** The doubt the contract reports still open (scanDoubt), or null. The
   *  resolver has already folded `reviewed` and `pending` into it. */
  doubt?: ScanDoubt | null;
  /** The doubt's sentence (scanDoubtWords), rendered as its own amber line
   *  for a short barcode. */
  doubtWords?: string | null;
}

export interface ScanNotesPlacement {
  /** Render the amber warning line under the title. */
  amber: boolean;
  /** Render the notes inside the Source data box. */
  sourceBox: boolean;
  /** What the amber line says, when it renders. */
  amberText: string | null;
  /** What the box says, when it renders. */
  boxText: string | null;
}

export function scanNotesPlacement({ notes, rateLimited, identifyFailed = false, reviewed = false, doubt = null, doubtWords = null }: ScanNotesInput): ScanNotesPlacement {
  const note = notes?.trim() || null;
  // The note itself is the warning: a throttled lookup, a failed identify,
  // or a doubt whose words the pipeline wrote into the note (a split's).
  const noteIsWarning = (rateLimited || identifyFailed || (doubt !== null && doubt !== "short-barcode")) && !reviewed;
  const amberText = doubt === "short-barcode" ? doubtWords : noteIsWarning ? note : null;
  // Never the same sentence twice on one card: the box carries the note only
  // when the amber line is not already saying it.
  const boxText = note && note !== amberText ? note : null;
  return { amber: !!amberText, sourceBox: !!boxText, amberText: amberText ?? null, boxText };
}
