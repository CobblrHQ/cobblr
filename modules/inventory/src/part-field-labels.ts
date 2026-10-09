// The words for a part's built-in fields where the name would not do. The
// manifest declares them (so a history entry, an activity sentence, a CSV
// header and the assistant say them) and the screens fall back to them, so
// a field is one word everywhere unless the workspace relabels it (#5176).
export const PART_FIELD_LABELS = {
  qty: "Quantity",
  min_qty: "Minimum",
} as const;
