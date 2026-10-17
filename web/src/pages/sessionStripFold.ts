// Whether a phone's session strip folds its email and parcel icons into the
// session's ⋯ (#6095, decided for the owner): the receipt, the place and Add
// stay one tap at 44 px, and the store's name gets the width back. Folding
// only pays when it frees a control: both icons are there (two leave, ⋯ comes
// or was already there), or ⋯ is on the row anyway. One icon alone, with no ⋯
// otherwise, stays: folding it would trade a control for a control.

export function phoneFoldsSourceIcons(row: { email: boolean; parcel: boolean; menuOtherwise: boolean }): boolean {
  if (!row.email && !row.parcel) return false;
  return (row.email && row.parcel) || row.menuOtherwise;
}
