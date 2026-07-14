// "Acquired from" -> "acquired_from".
//
// A field has a human LABEL and a machine KEY. The key is what templates
// ({{acquired_from}}), the API, and CSV headers use, and the server validates it
// as /^[a-z][a-z0-9_]*$/. Nobody should have to hand-write snake_case to add a
// field, so the key is derived from what they actually typed — and stays editable
// for the rare case they want a different one.
//
// This lives in lib (not the page) because it's pure and load-bearing: a key that
// fails the server's pattern comes back as a 400 the user can't diagnose from the
// label they typed.

/** Derive a valid field key from a display label. Returns "" for a label with
 *  nothing usable in it (e.g. "!!!"), which the caller treats as "not ready". */
export function slugifyFieldName(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      // Anything that isn't a-z0-9 becomes a separator: spaces, punctuation,
      // accents, emoji.
      .replace(/[^a-z0-9]+/g, "_")
      // The key must START with a letter, so drop any leading digits or
      // underscores ("3D printer" -> "d_printer"). Without this the server
      // rejects the create and the label looks fine.
      .replace(/^[^a-z]+/, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60)
  );
}

/** The server's rule, mirrored so the form can say so before the round trip. */
export function isValidFieldKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key);
}
