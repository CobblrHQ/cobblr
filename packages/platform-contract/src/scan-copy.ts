// The sentences a scan card shows for a store's own code, and the rule every
// card sentence follows.
//
// The card's note for a store code ran to 164 characters with a parenthetical
// and the phone card clipped it at "so there is nothi..." (#3017). The owner:
// "severely shorten and make more user friendly phrases like this." So every
// sentence a card shows (a lookup verdict, a routing note, a review reason,
// a tool-hint reason, the model's note) is one plain sentence of at most
// CARD_SENTENCE_MAX characters, no parentheses, no because or so-that
// clause; the why goes in the title. `lint:scan-card-copy` holds the files
// that write them to it.
//
// Buildless subpath: no runtime import of a sibling.

/** The longest sentence a card shows. A phone card has one line for it. */
export const CARD_SENTENCE_MAX = 70;

/** What the card says for a store's own label: the note on the row, the
 *  review reason, and the sheet's state. One sentence, read everywhere. */
export const STORE_CODE_NOTE = "A store's own code, nothing to look up. Name it to file it.";

/** The why, for the title or tooltip beside it. A title, not a card line,
 *  which is what the lint's `_TITLE` exemption says. */
export const STORE_CODE_TITLE =
  "A deli, produce or in-store code that only that shop can read: no catalog knows it. Name it and it files like a typed item.";

/** The routing line for a store code that has no name yet: the pill already
 *  names the table, so the sentence does not. */
export const STORE_CODE_ROUTING = "No name yet. Files as a generic item.";

/** The doubt a short barcode raises (EAN-8, UPC-E, a truncated code: the
 *  catalogs can answer with a confident stranger that shares the digits).
 *  Rendered from the row's state while the doubt is open, never stored in
 *  the note (#3057): "Looks fine" retires the doubt, and a warning baked into
 *  the note outlived the tap that was meant to dismiss it. */
export const SHORT_BARCODE_DOUBT = "Short barcode. Double-check this is the right product.";

/** The doubt the pipeline raised without saying which kind. */
export const UNTRUSTED_DOUBT = "The identification is not trusted. Check it.";

/** The doubt on a split piece read from the group photo, not its own crop. */
export const SPLIT_GROUP_DOUBT = "Identified from the group photo, not its own crop. Check it.";

/** The doubt on split pieces that disagree about what they are. */
export const SPLIT_SIBLINGS_DOUBT = "The pieces split from one photo disagree on what this is.";

// The row's ONE sentence: the actual problem and what to do, selected from
// its state by scan-triage's scanRowState (#3063). A card shows the sentence
// or nothing; a paragraph of routing prose is never the reason.

/** A row nothing could name. */
export const NO_NAME_SENTENCE = "No name yet. Name it to file it.";

/** A row whose lookup was throttled and has not answered. */
export const THROTTLED_SENTENCE = "The lookup was throttled. Wait, or name it yourself.";

/** A route the keyword floor guessed with no AI; a person confirms it. */
export const KEYWORD_ROUTE_SENTENCE = "Routed by keywords, not the AI. Confirm where it goes.";

/** The workspace already tracks one unique thing this looks like (a set, a
 *  book, a machine: a record with no count, where +1 would double it). */
export const DUPLICATE_SENTENCE = "You already have one of these. Compare before adding.";

/** The workspace counts this thing already: filing is one more of it. */
export const MERGE_SENTENCE = "You already have this. Adding counts one more.";

/** The destination is a table this workspace has not installed. `{table}`
 *  is the destination's label. */
export const INSTALL_SENTENCE = "{table} is not set up yet. Adding installs it.";

/** The person may not file here. */
export const BLOCKED_SENTENCE = "You cannot file here. Ask a workspace admin.";

/** A confident-enough score is not a reason; a low one asks for a look.
 *  `{pct}` is the whole-number percentage. */
export const LOW_CONFIDENCE_SENTENCE = "Identified at {pct}% confidence. Check the name.";

/** The one word on the action for each eligibility. */
export const ACTION_ADD = "Add";
export const ACTION_INSTALL_ADD = "Install & add";
export const ACTION_MERGE = "+1 more";
export const ACTION_REVIEW = "Review";
export const ACTION_BLOCKED = "Ask an admin";

/** Fill a sentence's `{slot}`s. */
export function fillSentence(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(slots[k] ?? ""));
}
