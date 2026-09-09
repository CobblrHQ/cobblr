// A list of everything a change will touch, folded when it is long.
//
// A confirm card must always say exactly what it is about to do, and for a
// bulk change that is a list: every record that moves, every place that goes.
// A hundred lines would push the buttons off the screen, so past a few the
// rest fold behind "and N more", and opening it scrolls rather than grows.
// The fold is presentation only: the whole list is always there to open.

export const FOLD_AT = 5;

export function foldLines(lines: string[], open: boolean, at = FOLD_AT): { shown: string[]; hidden: number } {
  // One over the fold is not worth a button: show it.
  if (open || lines.length <= at + 1) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, at), hidden: lines.length - at };
}
