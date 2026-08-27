// An entity kind, and the two halves it is made of.
//
// A record is identified two ways across this platform and they are NOT
// interchangeable:
//
//   kind          "inventory:part"   one composite string  (EntityRef.kind)
//   module + type "inventory", "part" two bare strings      (FileAttachSpec, tag assignments)
//
// Splitting one into the other is three characters of string work, which is
// exactly why it kept being done by hand at each call site — and why one of
// those call sites got it wrong in a way nothing could catch. `core-scan`'s
// add-qty path did:
//
//   const [module] = kind.split(":");
//   { source_module: module, source_type: kind }     // <- the WHOLE kind
//
// so a gallery attachment was written with source_type "inventory:part" while
// every reader queries for "part". The row was orphaned on write. Nothing threw,
// nothing logged, and the visible thumbnail still worked because that path also
// PATCHes image_path directly — so the only symptom was a photo missing from a
// gallery, months from the commit that caused it.
//
// Both halves come from one function now, so the pair cannot disagree. Pure and
// dependency-free, so it is cheap to test properly rather than by eye.

export interface EntityKindParts {
  /** The owning module, e.g. "inventory". */
  module: string;
  /** The bare record type WITHIN that module, e.g. "part". Never composite. */
  type: string;
}

/** Split `"<module>:<type>"`. Throws on anything else — a malformed kind is a
 *  programming error, and the alternative is writing a row nothing can read. */
export function splitEntityKind(kind: string): EntityKindParts {
  const i = kind.indexOf(":");
  if (i <= 0 || i === kind.length - 1) {
    throw new Error(`entity kind must be "<module>:<type>", got "${kind}"`);
  }
  const type = kind.slice(i + 1);
  // A second colon means the caller passed something composite as the type,
  // which is the mistake this function exists to stop.
  if (type.includes(":")) {
    throw new Error(`entity kind has too many segments: "${kind}"`);
  }
  return { module: kind.slice(0, i), type };
}

/** Join the two halves back into a kind. The inverse of `splitEntityKind`. */
export function entityKindOf(parts: EntityKindParts): string {
  return `${parts.module}:${parts.type}`;
}
