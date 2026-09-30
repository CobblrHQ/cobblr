// Which of a record's fields a person writes, as a column of a spreadsheet.
//
// One rule for both directions: the spreadsheet import offers these as the
// places a column can go, and the export writes these as its columns, so a
// file taken out goes back in to the same fields and nothing else. Read-only
// fields (a count of what is assigned, a location's name looked up from its
// id) are the module's to keep, not the file's; the fields below have a column
// of their own (Quantity, Location, Category) or are the record's plumbing.

/** Handled by a column of their own, or never a person's to write. */
export const SPECIAL_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "id", "name", "metadata", "instance", "location_id", "category_id", "image_path", "qty", "unit",
  "approximate_qty", "estimated_at", "archived", "state",
]);

export interface ColumnFieldLike {
  name: string;
  type?: string;
  readOnly?: boolean;
}

/** A kind's own (native) field that a spreadsheet column writes. */
export function isWritableNativeField(f: ColumnFieldLike): boolean {
  return !f.readOnly && !SPECIAL_NATIVE_FIELDS.has(f.name) && f.type !== "object" && f.type !== "image-path";
}

/** A custom field that a spreadsheet column writes: not worked out from
 *  other fields, and not a link to another record, which a sheet names in
 *  words the import cannot tell apart from a place. */
export function isWritableCustomField(f: { type: string }): boolean {
  return f.type !== "computed" && f.type !== "relation";
}

/** A native field's column name when the workspace has not renamed it. */
export function columnLabel(name: string): string {
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
