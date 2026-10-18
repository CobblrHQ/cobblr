// A notification's card says its substance once.
//
// The message is the card's title. A digest of one item builds its message
// from that item's line, so the card's body and its one row are the same words
// again (the eggs that expire in 5 days, once as the title and once bold,
// #7077). Both inboxes ask here before drawing a line under the title, so a
// module that builds its card that way never shows it twice, and a module that
// writes a different line keeps it.

function plain(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*[•*-]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Does this line only repeat the notification's own message? */
export function repeatsMessage(line: string | null | undefined, message: string): boolean {
  if (!line) return false;
  return plain(line) === plain(message);
}
