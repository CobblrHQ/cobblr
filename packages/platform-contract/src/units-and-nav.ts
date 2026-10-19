// ── Units (vocabulary owner: core-units) ────────────────────────────────────
// Server-side unit resolution/conversion for modules + the kernel. The
// vocabulary AND the conversion math live in core-units (see
// scripts/lint-unit-conversion.ts — nothing else may hand-roll factors);
// this surface is how any consumer asks. A field def's declared `unit`
// resolved here is what gives a number machine-readable physical semantics
// (a length-category unit IS a length) — never the field's name.

/** A resolved unit: identity + category + the category-base factor when
 *  convertible (count-style units carry none). */
export interface PlatformUnitInfo {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: string;
  factor?: number;
}

export interface UnitsService {
  /** Resolve a raw unit string ("mm", "grams") against the built-in
   *  vocabulary + the org's custom units. Null when unknown. */
  resolve(orgId: string, raw: string): Promise<PlatformUnitInfo | null>;
  /** Convert between raw unit strings (same category, both factored).
   *  Null when not convertible. */
  convert(orgId: string, value: number, fromRaw: string, toRaw: string): Promise<number | null>;
}

/** The shape of the navigation: the headings a workspace has grouped its
 *  sections under.
 *
 *  Here because it was the one thing the assistant could describe and not do.
 *  Asked to group two sections under a parent he answered correctly and then
 *  printed "[Take user to Presentation configuration screen]" — a stage
 *  direction, because nav lived in kernel routes with no action behind it and
 *  signposting was all he had. A capability the user can reach and Cobb cannot
 *  is a capability half-built. */
export interface PlatformNav {
  /** Every heading, with what sits under it. */
  listHeadings(orgId: string): Promise<
    Array<{
      id: string;
      name: string;
      members: Array<{ target_kind: string; target_id: string }>;
    }>
  >;
  createHeading(orgId: string, name: string, icon?: string | null): Promise<{ id: string }>;
  /** Move a nav entry under a heading. An entry belongs to at most one, so this
   *  takes it out of any other. */
  addMember(orgId: string, headingId: string, targetKind: string, targetId: string): Promise<void>;
  removeMember(orgId: string, targetKind: string, targetId: string): Promise<void>;
  deleteHeading(orgId: string, headingId: string): Promise<void>;
  /** What can go under a heading, with the names a person would use for them —
   *  so a request naming "Spices" can be resolved without the caller knowing
   *  what an instance id looks like. */
  listEntries(orgId: string): Promise<Array<{ kind: string; id: string; label: string }>>;
}

export interface PlatformUnits {
  /** The vocabulary owner (core-units) registers this at load. */
  registerService(svc: UnitsService): void;
  /** Null when unknown, or when no service is registered (core-units off) —
   *  consumers degrade to "no physical semantics", never guess. */
  resolve(orgId: string, raw: string): Promise<PlatformUnitInfo | null>;
  convert(orgId: string, value: number, fromRaw: string, toRaw: string): Promise<number | null>;
}
