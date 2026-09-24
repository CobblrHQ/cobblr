// The fields an inventory phone card draws on its own line (the name, the
// count, the category, the location, the maker). A view's declared fields are
// added below them, so these are skipped there rather than shown twice. One
// list for the card and for the test that holds it (#3626).
export const CARD_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "name",
  "qty",
  "category",
  "location",
  "min_qty",
  "manufacturer",
]);
