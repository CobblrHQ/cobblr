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

/** A shop's own code named from the item itself (#6100): from the photo and
 *  its label, or from this workspace's own filing of the same code, never
 *  from a global catalog, which answers with some other shop's product. */
/** A name read off a label that a stricter read no longer stands behind
 *  (#6100: "Uni" off the owner's cumin). */
export const LABEL_CLEARED_NOTE = "No name on its photos could be read. Name it to file it.";
/** A row named from the biggest words on its photo's label (#6100). */
export const LABEL_NAME_NOTE = "Named from the biggest words on its label.";
/** A photo read that described the picture instead of naming it (#6100). */
export const PROSE_NAME_NOTE = "The photo's read described it, not named it. Name it to file it.";
/** A barcode catalog that named only the brand, not the product (#6146). */
export const BRAND_ONLY_NOTE = "Only its brand is known, not which product. Check the name.";
export const STORE_CODE_PHOTO_NOTE = "A shop's own barcode, so it was named from your photo, not looked up.";
export const STORE_CODE_FILED_NOTE = "A shop's own barcode, named as you filed it here before.";

/** The why, for the title or tooltip beside it. A title, not a card line,
 *  which is what the lint's `_TITLE` exemption says. */
export const STORE_CODE_TITLE =
  "A deli, produce or in-store code that only that shop can read: no catalog knows it. Name it and it files like a typed item.";

/** An Amazon fulfilment sticker (FNSKU, X00 plus seven letters and digits):
 *  the code is Amazon's own and no catalog resolves it, but the sticker
 *  prints the product's title under it, and the scan frame holds the
 *  sticker (#4933). Named from that title, the row says where its name came
 *  from; with no title read, it says so and asks for the name, never for
 *  another photo of a label it already has. */
export const FNSKU_READ_NOTE = "Named from the title on its Amazon label.";
export const FNSKU_NOTE = "An Amazon label, and its title could not be read. Name it to file it.";
export const FNSKU_TITLE =
  "An Amazon fulfilment code (FNSKU) identifies a unit only inside Amazon's warehouse, so no catalog looks it up. The product's title is printed under it on the label.";

/** A scanned code the server classified as one no catalog looks up (its
 *  `code_type` on the row's metadata), with what every surface says about
 *  it: the card's line, the note, the title beside it. Null for a product
 *  barcode, which a lookup judges. One reader, so the live sheet and the
 *  inbox cannot tell two different stories about one sticker (#4933). */
/** The code kinds the scan's classifier knows that a product lookup does
 *  not judge. core-scan's ScanCodeType is built from this list, so a kind
 *  cannot be classified without its words here: the generic "we couldn't
 *  find this barcode" is for a product barcode, and only for one. */
export const CLASSIFIED_CODE_TYPES = ["store-code", "fnsku", "isbn", "asin", "url"] as const;
export type ClassifiedCodeType = (typeof CLASSIFIED_CODE_TYPES)[number];

const CLASSIFIED_WORDS: Record<ClassifiedCodeType, Omit<ClassifiedCode, "type">> = {
  "store-code": { line: "A store's own code, nothing to look up. Name it:", note: STORE_CODE_NOTE, title: STORE_CODE_TITLE },
  fnsku: { line: "An Amazon label, and its title could not be read. Name it:", note: FNSKU_NOTE, title: FNSKU_TITLE },
  isbn: {
    line: "A book's ISBN no catalog knows yet. Name it:",
    note: "A book's ISBN that no book catalog knows yet. Name it to file it.",
    title: "An ISBN identifies a book; the book catalogs did not have this one.",
  },
  asin: {
    line: "An Amazon product code that did not resolve. Name it:",
    note: "An Amazon product code that did not resolve. Name it to file it.",
    title: "Amazon's own product number; its page did not name it.",
  },
  url: {
    line: "A link that did not say what it is. Name it:",
    note: "A link that did not say what it is. Name it to file it.",
    title: "The code is a web address, and its page did not name a product.",
  },
};

export interface ClassifiedCode {
  type: ClassifiedCodeType;
  /** The card's lead-in before the name box. */
  line: string;
  /** The row's note while it has no name. */
  note: string;
  /** The why, for a title or tooltip. */
  title: string;
}

export function classifiedCodeOf(meta: unknown): ClassifiedCode | null {
  const type = (meta as { code_type?: unknown } | null)?.code_type;
  return typeof type === "string" && (CLASSIFIED_CODE_TYPES as readonly string[]).includes(type)
    ? { type: type as ClassifiedCodeType, ...CLASSIFIED_WORDS[type as ClassifiedCodeType] }
    : null;
}

/** The routing line for a store code that has no name yet: the pill already
 *  names the table, so the sentence does not. */
export const STORE_CODE_ROUTING = "No name yet. Files as a generic item.";

/** The doubt a short barcode raises (EAN-8, UPC-E, a truncated code: the
 *  catalogs can answer with a confident stranger that shares the digits).
 *  Rendered from the row's state while the doubt is open, never stored in
 *  the note (#3057): "Looks fine" retires the doubt, and a warning baked into
 *  the note outlived the tap that was meant to dismiss it. */
export const SHORT_BARCODE_DOUBT = "Short barcode. Double-check this is the right product.";

/** The doubt, worded by its suspect (#6100): a barcode whose digits check out
 *  is right, so what a catalog said about it is what is in doubt. */
export const STORE_CODE_NAME_DOUBT = "A shop's own barcode: names found online may be other products.";
export const SHORT_BARCODE_NAME_DOUBT = "A short barcode, so the name found for it may be another product's.";
export const BARCODE_MISREAD_DOUBT = "This barcode may be misread: check it against the label.";
/** The question a name doubt asks, and the source of the photo's answer. */
export const NAME_DOUBT_PROMPT = "Is this the right name?";
export const PHOTO_NAME_SOURCE = "read off your photo";

/** An identification's confidence as a person reads it: never a bare 0.30
 *  on the card (#6100). Null when there is none to say (no score, or 0,
 *  which is "nothing identified" and is said elsewhere). */
export function confidenceInWords(score: string | number | null | undefined): string | null {
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 0.8) return "high confidence";
  if (n >= 0.5) return "medium confidence";
  return "low confidence";
}

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

/** Text read off the label in the scan frame that did not make a confident
 *  name (#4933): offered the same way, one tap, saying where it came from,
 *  never typed back by hand. */
export const LABEL_GUESS_SOURCE = "read off its label";
export const LABEL_GUESS_BECAUSE = "Read off the label in your scan; check it reads right.";

/** A second person scanned the same code while the row waited (#8851):
 *  another one, or one item scanned by both of them. The count already holds
 *  both; a person who knows it was one sets it. */
export const SCANNED_TOO_SENTENCE = "{who} scanned this too. Set the count if it was one.";

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
export const AMBIGUOUS_MATCH_SENTENCE = "This could be any of {n} things you have. Open it to pick."; // count-plural-ok: only shown for two or more

/** The scan is one thing the workspace keeps in several places, and nothing
 *  says which place this is: not the place being worked in, and nobody has
 *  picked. A person does, once; the choice stays on the row. */
export const WHICH_PLACE_SENTENCE = "You keep this in {n} places. Open it to pick which one."; // count-plural-ok: only shown for two or more
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
export const INSTALL_SENTENCE = "{table} is not set up yet. Adding turns it on.";

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
/** A table that is not on yet: the button says what it does, in the words a
 *  person uses ("Turn on Sets and add"), never "install" (#4577). */
export function actionInstallAdd(table: string): string {
  return `Turn on ${table} and add`;
}
/** A re-buy's button: what the line adds to the record you have, "+10 more"
 *  for a 10-pack, never "+1 more" over a write of 10 (#5719). */
export function actionMerge(count = 1): string {
  return `+${Math.max(1, count)} more`;
}
export const ACTION_MERGE = actionMerge(1);
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

/** The session's primary button: where the items go (#4577). One collection
 *  names it; several say so, and the session's caption lists them. `n` is how
 *  many the button covers, `tables` the distinct collections they go to and
 *  `off` the ones among them not turned on yet. */
export function sessionAddLabel(n: number, tables: readonly string[], off: readonly string[]): string {
  if (tables.length === 1) return off.length ? `Turn on ${tables[0]} and add ${n}` : `Add ${n} to ${tables[0]}`;
  return `Add ${n} to their collections`;
}

/** The line under the session header that carries what the button cannot:
 *  every destination, and what turning a collection on means. Null when the
 *  button already says it all. `place` is the session's place, when one is
 *  set. */
export function sessionAddCaption(n: number, tables: readonly string[], off: readonly string[], place: string | null): string | null {
  const them = n === 1 ? "it" : "them";
  const parts: string[] = [];
  if (tables.length > 1) parts.push(tables.join(" · "));
  if (off.length === 1) parts.push(`${off[0]} isn't on yet; this turns it on, then adds ${them}`);
  else if (off.length > 1) parts.push(`${off.join(" and ")} aren't on yet; this turns them on, then adds ${them}`);
  let line = parts.join(". ");
  if (place) line = line ? `${line}, in ${place}` : tables.length === 1 ? `${tables[0]}, in ${place}` : "";
  return line || null;
}

/** The line a row's note carries while its photo check runs. A live STATUS, not
 *  provenance (#4583): it is shown only while the check is running, and never
 *  read back from the stored note once the check has finished or died. */
export const PHOTO_CHECK_NOTE = "Checking this against your photo…";

/** How long a photo check may be pending before the line stops claiming it is
 *  still running: the job is detached, and one that died leaves its flag. */
export const PHOTO_CHECK_LIVE_MS = 10 * 60 * 1000;

/** Is the photo check still running? The row says it is pending AND it was
 *  touched recently enough that the job can plausibly be alive. Pure. */
export function photoCheckIsLive(
  row: { suggested_metadata?: unknown; updated_at?: string | Date | null },
  now: number = Date.now(),
): boolean {
  const pending = (row.suggested_metadata as { photo_check_pending?: unknown } | null)?.photo_check_pending === true;
  if (!pending) return false;
  const at = row.updated_at == null ? NaN : new Date(row.updated_at).getTime();
  return Number.isFinite(at) && now - at < PHOTO_CHECK_LIVE_MS;
}

/** A match only a person settles (#5921): "Is this the 2019 Honda Civic?
 *  Matched by name; the VIN didn't read; check it's this car." */
export const CONFIRM_MATCH_SENTENCE = "Is this {title}? {why}.";
