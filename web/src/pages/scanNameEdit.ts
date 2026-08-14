/** Should an edit to the confirm form's NAME field be written back to the inbox
 *  row?
 *
 *  Editing that field used to change only what the item would be FILED as: the
 *  value went to confirmScanItem and never to the row, so the card's title kept
 *  showing the AI's name while the field said something else, and leaving
 *  without committing threw the correction away entirely (reported 2026-08-13).
 *  Renaming an inbox item is already a supported action - five other surfaces
 *  call updateScanItem({ name }) - so this field joins them.
 *
 *  The interesting part is when NOT to. Two ways a naive "save on blur" goes
 *  wrong, and the second is why this is a tested function rather than an inline
 *  condition:
 *
 *  1. The field is seeded from the CANDIDATE's reconciled name, which
 *     legitimately differs from the row's `suggested_name` (the matchmaker
 *     strips retailer noise). Saving on blur alone would rewrite the row's name
 *     just because someone opened the form and tabbed past the field.
 *
 *  2. PATCH /inbox/:id reports a renamed BARCODE item to the shared Barcode
 *     Intelligence DB - "the resolver's name was wrong and the human's is
 *     truth". A phantom rename therefore does not just muddle one row: it
 *     publishes a bogus correction for that UPC to every workspace that ever
 *     scans it.
 *
 *  So: a real keystroke, a non-empty result, and an actual change from what the
 *  row already holds. */

export interface NameEditState {
  /** The user typed in the field. Merely rendering the seeded value is not an edit. */
  dirty: boolean;
  /** The field's current value. */
  next: string;
  /** The row's stored `suggested_name`. */
  rowName: string | null | undefined;
}

export function shouldPersistNameEdit({ dirty, next, rowName }: NameEditState): boolean {
  if (!dirty) return false;
  const trimmed = next.trim();
  // Clearing the box is not a rename to "". The commit path still requires a
  // name, and the placeholder shows what it would fall back to.
  if (!trimmed) return false;
  return trimmed !== (rowName ?? "").trim();
}
