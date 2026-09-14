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
