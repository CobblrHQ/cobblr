// The universal base every entity kind keeps, regardless of which module it
// borrows its shape from. Everything else a module declares — a domain-native
// like assets' state/warranty/serial or inventory's qty/reorder — is what the
// "Just the essentials" preset hides, so a Bookshelf riding on the assets module
// stops showing a drill-press's fields. This is the no-code form of the
// "a kind owns its fields" rule (see _tmp/field-model-and-record-detail-spec.md).
export const BASE_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "image_path",
  "location_id",
  "notes",
]);

/** The native fields the essentials preset hides: everything a module declares
 *  that isn't part of the universal base. Pure so it can be unit-tested. */
export function nonEssentialNativeFields(nativeNames: readonly string[]): string[] {
  return nativeNames.filter((n) => !BASE_NATIVE_FIELDS.has(n));
}
