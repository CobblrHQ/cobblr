import type { EntityRef } from "@cobblr/platform-contract/placement";
import type { FieldRole } from "@cobblr/platform-contract/field-vocabulary";

/** Fields as a platform seam, for a module that owns a field a bundle
 *  declared and has folded into another: `retire` removes that field's
 *  definition from one kind (values already recorded stay on the records, as
 *  a hand-removed field's do). The one door so a module never reaches the
 *  field-def table itself. Resolves with how many definitions went. */
export interface PlatformFields {
  retire(args: { orgId: string; kind: string; name: string }): Promise<number>;
  /** The names of a kind's fields that carry `role` (its own and the ones a
   *  trait scope puts on it, "@physical"), so a module reads a meaning
   *  without guessing a field's name: a thing's outer size, say. */
  withRole(args: { orgId: string; kind: string; role: FieldRole }): Promise<string[]>;
}

/** Tags as a platform seam. core-tags OWNS the tables and the HTTP surface;
 *  this is the in-process way for a background writer with no request bearer
 *  (the sync engine) to attach a tag to an entity it just wrote, without
 *  reaching into core-tags' tables or looping through HTTP. Attach-by-name,
 *  created on first use, idempotent on (tag, entity). Org-scoped; the caller
 *  passes orgId. `target.kind` is "<module>:<type>", the same spelling the
 *  entity-kind registry uses. */
export interface PlatformTags {
  /** Attach `tagName` to `target`, creating the tag if it does not exist.
   *  `created` says whether a NEW assignment was made (false = already there);
   *  `tagCreated` whether the tag itself is new, so an undo knows whether the
   *  tag is its to take away. */
  attach(args: { orgId: string; tagName: string; target: EntityRef }): Promise<{ tagId: string; created: boolean; tagCreated?: boolean }>;
  /** Take a tag away when nothing carries it: the inverse of the create inside
   *  `attach`, for an undo. A tag still on anything stays. */
  withdraw(args: { orgId: string; tagName: string }): Promise<"withdrawn" | "in-use" | "absent">;
  /** Remove `tagName` from `target`. No-op if absent; never deletes the tag. */
  detach(args: { orgId: string; tagName: string; target: EntityRef }): Promise<void>;
  /** The tag names on `target`. */
  of(args: { orgId: string; target: EntityRef }): Promise<string[]>;
}

/** Where a kind's grouping axis is stored, and so where a chosen value goes.
 *
 *  The discriminator lives HERE and nowhere else: a caller ranks against
 *  `values`, presses `commit`, and applies what comes back. Nothing outside
 *  this seam asks which storage a kind uses, which is the whole point of it
 *  (#3223: a value written to one store is invisible to the feature reading
 *  the other). */
export type CategoryAxisSlot =
  /** A custom field def on the kind; the value is the label itself. */
  | { kind: "extras"; name: string; defId: string }
  /** A column on the record pointing at the module's own taxonomy; the value
   *  written is a record id, never the label. */
  | { kind: "native"; column: string; entityKind: string }
  /** A native text field on the record (a kind's `categoryField`); the value
   *  is the label itself. */
  | { kind: "field"; column: string };

export interface CategoryAxis {
  /** What to call it on screen ("Category", "Scan category"). */
  label: string;
  /** What to RANK against: every value the store holds now, deduplicated by
   *  `normaliseCategory` so one key never appears twice.
   *
   *  NOT "what exists": a caller may rank against this list PLUS proposals of
   *  its own that are in no store yet (the scan batch's sibling proposals,
   *  which is what stops five monitors in one run becoming three categories).
   *  `commit` therefore has to accept a value that was never in this list. */
  values: string[];
  /** Where a chosen value is written. */
  slot: CategoryAxisSlot;
}

/** What to write for a chosen value, or null when there is nothing to write.
 *  `value` is the label for an `extras` slot and a record id for a `native`
 *  one, which is why a caller must apply it through `applyAxisValue` rather
 *  than reading the slot itself. */
export interface CategoryAxisAssignment {
  slot: CategoryAxisSlot;
  value: string;
}

export interface PlatformCategoryAxis {
  /** The axis for a kind, or null when it has none.
   *
   *  Memoised briefly per (org, kind, instance): a menu assembly asks once per
   *  kind per row, and a native read is a taxonomy listing rather than a column
   *  on a def. `commit` invalidates the entry it grew, so a value confirmed a
   *  moment ago is in the next caller's `values`. */
  for(args: { orgId: string; kind: string; instance?: string | null }): Promise<CategoryAxis | null>;
  /** Grow the vocabulary if this value is new, and return what to write.
   *
   *  NEVER throws and never fails the operation that called it: a value that
   *  cannot be stored (the kind has no axis, the taxonomy refuses the create,
   *  the value normalises to nothing) comes back as null and is dropped, which
   *  is what the scan confirm has always done with a field-def PATCH that came
   *  back non-ok. Filing the thing matters more than filing it under a name. */
  commit(args: {
    orgId: string;
    kind: string;
    value: string;
    instance?: string | null;
  }): Promise<CategoryAxisAssignment | null>;
  /** What to write for the value the record's slot ALREADY holds (read with
   *  `readAxisValue`), which is a name on a choice-backed axis and a record
   *  id on a native one. `commit` takes names only; handing it a slot's id
   *  made a category named after the id. The caller never says which it
   *  has, because the slot it came from does.
   *
   *  A name is committed as `commit` would (and kept as typed if it cannot
   *  be stored). An id is kept when a record has it; one in no store (deleted
   *  since the form loaded, or read off the wrong kind) is logged and comes
   *  back null, and the caller empties the slot and files under a name
   *  instead. Never throws. */
  keep(args: {
    orgId: string;
    kind: string;
    value: string;
    instance?: string | null;
  }): Promise<CategoryAxisAssignment | null>;
  /** Take a value back out of the vocabulary: the inverse of `commit`, for an
   *  undo that grew it. Only when no record of the kind files under it; a
   *  value somebody has used since stays, and the answer says so, because the
   *  undo is taking back what IT did, not what a person did afterwards.
   *
   *  `withdrawn` it went; `in-use` a record still files under it; `absent`
   *  it was not there (already gone is the state the caller wanted);
   *  `unsupported` the kind has no axis. Never throws. */
  withdraw(args: {
    orgId: string;
    kind: string;
    value: string;
    instance?: string | null;
  }): Promise<"withdrawn" | "in-use" | "absent" | "unsupported">;
}

export interface PlatformPairings {
  /** Link two records, once. Returns the link's id: the new one, or the one
   *  already there when this exact link (same kinds, ids and relationship)
   *  exists, so asking again on a retried or repeated write never makes a
   *  second row (#8040). Org-scoped: the caller passes orgId. */
  create(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
    createdBy?: string | null;
    /** What the link is, in words, for a target that is not a record here
     *  (a document in a document system): what a reader of the links sees
     *  beside its id. */
    notes?: string | null;
    /** How to name and open a target that has no Cobblr detail route. */
    presentation?: import("./pairing-presentation.js").PairingResultPresentation;
  }): Promise<{ id: string }>;
  /** Add or refresh the presentation of one exact relationship. Existing
   * metadata owned by other features is preserved. */
  present(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
    presentation: import("./pairing-presentation.js").PairingResultPresentation;
  }): Promise<{ updated: number }>;
  /** Remove the pairing(s) matching this exact relationship. Returns how many
   *  rows went; removing something that is not there is a no-op, not an error
   *  (the same shape placement.remove has).
   *
   *  The inverse of `create`, and it was missing: modules could make a link and
   *  never unmake one, so a module whose links are DERIVED from something
   *  editable — a mention inside a comment, say — had no way to reconcile when
   *  the thing that justified the link was edited away. The only alternatives
   *  were leaving stale links forever or deleting from `entity_pairings`
   *  directly, and that table has one chokepoint on purpose.
   *
   *  Matched on the whole tuple INCLUDING relationshipKind, so a caller can
   *  only ever remove links of a kind it created. Removing every link between
   *  two entities regardless of rel would let one module quietly delete
   *  another's, or a user's own hand-made one. */
  remove(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
  }): Promise<{ removed: number }>;
  /** The distinct targets of this relationship's pairings of one target kind,
   *  made before `madeBefore`, in id order, `limit` at a time after
   *  `afterTargetId`. For a module that checks which of the records it owns
   *  its links still point at (a heal finding links to records that are gone). */
  listTargets(args: {
    orgId: string;
    targetKind: string;
    relationshipKind: string;
    madeBefore: Date;
    afterTargetId?: string;
    limit: number;
  }): Promise<string[]>;
  /** Remove every pairing of this relationship that points AT one of these
   *  targets, whatever its source. For a module that deletes the targets it
   *  owns (a catalog taking its entries with it) and must not leave links to
   *  records that no longer exist. Same rule as `remove`: only links of the
   *  named relationship, so another module's links are never touched. */
  removeByTargets(args: {
    orgId: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<{ removed: number }>;
  /** Insert many pairings at once, each once: a link already there, or named
   *  twice in the batch, is not written again, and `inserted` counts only the
   *  new ones. Used by bricklink.disassemble-kit to write hundreds of
   *  "matches" / "derived-from" rows, and by a kiln firing on create and finish. */
  createMany(
    rows: Array<{
      orgId: string;
      sourceKind: string;
      sourceId: string;
      targetKind: string;
      targetId: string;
      relationshipKind: string;
      createdBy?: string | null;
    }>,
  ): Promise<{ inserted: number }>;
  /** Bulk pairing lookup. "Given these N target entities, which
   *  source-side entities point at them via `relationshipKind`?"
   *  Returns { sourceId, sourceKind, targetId } so the caller can group
   *  by target. `sourceKind` narrows it to one kind; left out, every
   *  kind counts, because the pairing is what makes a row a match, not
   *  the table it is on: a brick on the Lego bundle's Bricks table
   *  (bricks:item) is matched to a part as surely as one on Parts
   *  (#5434). Used by bricklink-connector's wanted-list diff to fan out
   *  from N catalog entries to every record matched to them in one
   *  query. */
  findByTargets(args: {
    orgId: string;
    sourceKind?: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; sourceKind: string; targetId: string }>>;
  /** The inverse of findByTargets. "Given these N source entities,
   *  which target-side entities of `targetKind` do they point at via
   *  `relationshipKind`?" One SQL round-trip; caller groups by
   *  sourceId. Used by inventory's parts-list endpoint to
   *  batch-resolve the matched catalog entry for every part on the
   *  page (so the inventory row can fall back to the catalog's
   *  image when image_path is empty). */
  findBySources(args: {
    orgId: string;
    sourceKind: string;
    sourceIds: string[];
    targetKind: string;
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; targetId: string }>>;
  /** Aggregate the pairings pointing AT each target: how many, and when the
   *  newest was made. The counting twin of findByTargets — which returns a row
   *  per pairing, so counting through it means hauling every row back to count
   *  them in JS.
   *
   *  One query however many targets. That matters: the reconciliation surfaces
   *  (a serialized model's `units_count`, and the stability window deciding
   *  whether its numbers have settled) read this for EVERY row of a list page,
   *  so a per-row version would be an N+1 on a hot path.
   *
   *  `latestCreatedAt` is max(created_at) over a target's current pairings — the
   *  "has this stopped changing?" signal. It only moves forward on an insert:
   *  deleting a pairing does not bump it, so a window built on it errs quiet
   *  rather than nagging. Targets with no pairings are simply absent from the
   *  result (the caller reads them as zero). See
   *  docs/design-decisions/serialized-rollup-and-stock-adjust.md. */
  countByTargets(args: {
    orgId: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<Array<{ targetId: string; count: number; latestCreatedAt: string }>>;
}

/** Read-only access to core-catalogs from other modules. Modules
 *  used to SELECT directly from `core_catalogs_*` tables, which
 *  violated module-layers.md §"What modules canNOT do." This
 *  surface gives the few operations modules legitimately need
 *  (semantic-type lookup, BOM-style entry filter, name+payload
 *  hydration) without the table-type leak. See B1 in
 *  2026-05-25-audit.md. */
export interface PlatformCatalogs {
  /** Find a catalog by its declared semantic_type. When several
   *  declare it, one that holds entries (or reads them from the
   *  hosted reference service) wins over an empty one, then the oldest. Returns null when no catalog declares the type. */
  findBySemanticType(
    orgId: string,
    semanticType: string,
  ): Promise<{ id: string; name: string; schema: Record<string, unknown> } | null>;
  /** Find a catalog by its bundle_external_id (suffix match). Used
   *  during a bundle uninstall to delete the right catalogs. */
  findByBundleExternalIdSuffix(
    orgId: string,
    suffix: string,
  ): Promise<{ id: string; name: string } | null>;
  /** Query entries within a catalog. JSON path filter is restricted
   *  to payload->>'<key>' = '<value>' equality — no arbitrary SQL.
   *  The kernel handles the org-scoping + table access. */
  queryEntries(args: {
    orgId: string;
    catalogId: string;
    /** Equality filters on payload JSONB keys. `{ set_num: "75192-1" }`
     *  → `payload->>'set_num' = '75192-1'`. */
    payloadEq?: Record<string, string>;
    externalIdIn?: string[];
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      catalogId: string;
      externalId: string;
      payload: Record<string, unknown>;
    }>
  >;
  /** Fuzzy-search entries in a catalog by trigram similarity against
   *  `payload->>'name'` (or a caller-supplied payload key). Returns
   *  top-K candidates with their similarity score (0..1, higher =
   *  more similar). Caller-side LLMs use this to pull candidates
   *  before running a structured match. Uses Postgres `pg_trgm` —
   *  the kernel owns the SQL so modules don't reach across schemas. */
  similaritySearch(args: {
    orgId: string;
    catalogId: string;
    queryText: string;
    /** payload key to match against. Defaults to "name". */
    payloadKey?: string;
    /** top-K cap. Defaults to 10, max 100. */
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      externalId: string;
      payload: Record<string, unknown>;
      score: number;
    }>
  >;
}
