// Cobb narrating what he wishes he could do.
//
// Asked how to group nav sections he answered correctly, then finished with a
// line in square brackets: "[Take user to Presentation configuration screen]".
// A stage direction — an instruction to a system that was never listening,
// printed to the person instead. Models write these when they can describe an
// action they have no way to take.
//
// Two halves to the fix and this is the second one: he CAN take you there now
// (he is told to link the screen, and the panel navigates), so the direction is
// both unnecessary and a leak. Stripped rather than trusted away, for the same
// reason ids are: the model writing it is not under our control.

/** A whole line that is nothing but a bracketed instruction. Deliberately not
 *  "any bracketed text" — [1] is a footnote, [Rack 1] may be a record's name,
 *  and eating those would cost more than the leak. */
const DIRECTION_LINE = /^\s*[[(](?:take|show|open|navigate|click|insert|link|redirect|display|go)\b[^\])]*[\])]\s*$/gim;

/** The same thing at the end of a paragraph rather than on its own line. */
const TRAILING_DIRECTION = /\s*[[(](?:take|navigate|redirect)\s+(?:the\s+)?user\b[^\])]*[\])]\s*$/gim;

export function stripStageDirections(text: string): string {
  if (!text) return text;
  return text
    .replace(DIRECTION_LINE, "")
    .replace(TRAILING_DIRECTION, "")
    // A stripped line leaves a hole in the middle of a paragraph run.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
