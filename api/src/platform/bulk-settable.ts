// Which native fields a batch edit may set by typing a value (bulk-set-field.ts).

/** Whether a batch may set this native field by typing a value. Where a
 *  record is kept is not: the batch has no place picker, so "location id"
 *  asked for a raw id nobody has (#8881), and Move to… is the one door that
 *  moves things and keeps their stock placement with them. */
export function bulkSettableNative(f: { name: string; type: string; readOnly?: boolean; role?: string }, hidden = false): boolean {
  return !f.readOnly && !hidden && f.role !== "quantity" && f.type !== "object" && f.type !== "image-path" && f.name !== "location_id";
}
