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

/** A receipt whose lines could not be read (#3581): the row is a receipt,
 *  not an unnamed item, so the card says so and offers Read again first. */
export const RECEIPT_UNREAD_TITLE = "Receipt not read";
export const RECEIPT_UNREAD_SENTENCE = "Its lines could not be read yet. Read it again.";
export const RECEIPT_READ_AGAIN = "Read again";
export const RECEIPT_AS_ITEM = "Treat it as one item";
export const RECEIPT_READ_ANYWAY = "Read it anyway";
/** Why a photographed receipt was not read in: it is in already. */
export function receiptAlreadyInSentence(label: string | null, lines: number): string {
  const where = label?.trim() ? `"${label.trim()}"` : "a session";
  return `This receipt is already in your inbox as ${where}${lines > 0 ? ` (${lines} line${lines === 1 ? "" : "s"})` : ""}.`;
}

/** A nameless row whose web guess was held for want of a second source
 *  (#2918): the card asks, with the guess as its one tap. The prompt, the
 *  tap's source and the why, read by the contract's question and the card. */
export const HELD_GUESS_PROMPT = "Is this it?";
export const HELD_GUESS_SOURCE = "found on the web, not confirmed";
export const HELD_GUESS_BECAUSE = "One page on the web says so; nothing confirmed it.";

/** A row whose lookup was throttled and has not answered. */
export const THROTTLED_SENTENCE = "The lookup was throttled. Wait, or name it yourself.";

/** A route the keyword floor guessed with no AI; a person confirms it. */
export const KEYWORD_ROUTE_SENTENCE = "Routed by keywords, not the AI. Confirm where it goes.";

/** The workspace already tracks one unique thing this looks like (a set, a
 *  book, a machine: a record with no count, where +1 would double it). */
export const DUPLICATE_SENTENCE = "You already have one of these. Compare before adding.";
/** A document for a thing you already have: it goes on that record (#4633). */
export const PAPERWORK_SENTENCE = "This is paperwork for {title}: put it on that record.";

/** The workspace counts this thing already: filing is one more of it. */
export const MERGE_SENTENCE = "You already have this. Adding counts one more.";

/** The scan matches several things the workspace has, equally well: no
 *  machine can pick, so a person does. */
export const AMBIGUOUS_MATCH_SENTENCE = "This could be any of {n} things you have. Open it to pick.";

/** The scan is one thing the workspace keeps in several places, and nothing
 *  says which place this is: not the place being worked in, and nobody has
 *  picked. A person does, once; the choice stays on the row. */
export const WHICH_PLACE_SENTENCE = "You keep this in {n} places. Open it to pick which one.";
/** The thing is already here, kept somewhere else: this scan is another place
 *  of it, never a second item (one item, a row per place). */
/** A document read off a page whose own checks did not pass on these
 *  fields (a VIN's check digit, lines that do not add up): a person looks. */
export const CHECK_FIELDS_SENTENCE = "Please check {fields}: the page did not read clearly.";
export const CHECK_FIELDS_WAITING_SENTENCE = "Please check {fields}. The AI reads it again when one is free.";
/** The document AI's allowance is used up for now (#4633). */
export const CHECK_FIELDS_LIMIT_SENTENCE = "The AI's daily limit is used up; it reads this again later.";
export const NEW_PLACE_SENTENCE = "You already have {title}: {held}. Add these as another place?";
export const NEW_PLACE_BARE_SENTENCE = "You already have this somewhere else. Add these as another place?";

/** The destination is a table this workspace has not installed. `{table}`
 *  is the destination's label. */
export const INSTALL_SENTENCE = "{table} is not set up yet. Adding installs it.";

/** The person may not file here. */
export const BLOCKED_SENTENCE = "You cannot file here. Ask a workspace admin.";

/** A field the evidence contradicts (#3070): `{source}` is where the
 *  evidence came from ("The cover"), `{evidence}` and `{claimed}` the two
 *  values, `{field}` the field's label. The template is short; the names
 *  it carries are the row's own. */
export const EVIDENCE_CONFLICT_SENTENCE = "{source} says {evidence}, not {claimed}. Check the {field}.";

/** The destination is a table only an admin can install, and this person
 *  is not one. `{table}` is the destination's label. Asking is the way. */
export const INSTALL_BLOCKED_SENTENCE = "{table} is not set up yet. Ask a workspace admin.";

/** The destination belongs to an app this deployment does not have at all,
 *  so no install or request can make it: the next step is another table.
 *  `{table}` is the destination's label. */
export const UNAVAILABLE_SENTENCE = "{table} is not available here. Pick another table.";

/** The AI was asked and did not answer (the row's coded identify_failure):
 *  the name is whatever else named it, and a person checks it. Never
 *  "connect AI": a manual check settles the row without one. */
export const AI_FAILED_SENTENCE = "The AI could not read this. Check the name.";

/** A confident-enough score is not a reason; a low one asks for a look.
 *  `{pct}` is the whole-number percentage. */
export const LOW_CONFIDENCE_SENTENCE = "Identified at {pct}% confidence. Check the name.";

/** The one word on the action for each eligibility. */
export const ACTION_ADD = "Add";
export const ACTION_INSTALL_ADD = "Install & add";
export const ACTION_MERGE = "+1 more";
export const ACTION_ADD_PLACE = "Add as another place";
export const ACTION_REVIEW = "Review";
export const ACTION_BLOCKED = "Ask an admin";

/** Fill a sentence's `{slot}`s. */
export function fillSentence(template: string, slots: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(slots[k] ?? ""));
}

/** A barcode no catalog knows: the scan worked and the lookup came up empty,
 *  so the next step is a photo of the thing (the owner, 2026-09-24). */
export const NO_MATCH_ASK_FOR_PHOTO = "We couldn't find this barcode. Take a photo so we can tell what it is.";

/** A capture no pass could identify: said plainly, with the way on (name it),
 *  never "Captured item" (the owner, 2026-09-24). */
export const COULD_NOT_TELL = "Couldn't tell what this is";

/** A barcode look-up's last word once its retries are spent, on the row and
 *  on the card: what happened, and the two ways on the card offers beside it.
 *  Never a promise of another attempt (#3710). */
export const LOOKUP_GAVE_UP = "Couldn't look this up. Take a photo or name it.";

/** The chip that offers the put-away walk. Accept files things where they
 *  belong on record; the walk is carrying them there. It used to read "2
 *  items left to place" the moment Accept was pressed, which reads as work
 *  left undone (#4146). A walk not begun is the next step; only a walk begun
 *  and left is something to resume. */
export function putawayWalkChip(remaining: number, places: number, resumed: boolean): string {
  const things = `${remaining} ${remaining === 1 ? "item" : "items"}`;
  if (resumed) return `Resume shelving - ${things} still to put away`;
  const where = places > 1 ? `, ${places} places` : places === 1 ? ", 1 place" : "";
  return `Shelve what you filed - ${things}${where}`;
}
