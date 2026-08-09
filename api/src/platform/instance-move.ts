// Moving a record between instances of one module.
//
// A record's kind string is derived from a single column (inventory's
// `instance`), so moving it between instances is an UPDATE, not a migration:
// the row stays, the uuid stays, the printed QR label keeps resolving, and no
// value can be lost because both sides are the same table. See
// docs/design-decisions/move-between-instances.md.
//
// What is NOT free is everything that stored the old kind string alongside the
// record's id. Those are soft references with no foreign keys, so one that
// nobody rewrites does not error: a tag, a photo, or a purchase line simply
// points at a kind the record is no longer. Hence the two lists below and
// scripts/lint-instance-move-satellites.ts, which fails the build when a
// kind-keyed table appears in neither.
//
// The lists were NOT hand-written. Three successive hand-written attempts
// (spec draft, spec review, then a widened lint) found 13, 22, and finally 32
// tables, because this tree uses four different naming conventions for the
// same idea (`entity_*`, `target_*`, `source_*`, `consumed_by_*`). The lint's
// enumeration is the truth; this file is what gets checked against it.

/** Where a table lives. The move cannot be one transaction: meta and tenant
 *  are separate databases (see the two-phase protocol in the design doc). */
export type SatelliteDb = "meta" | "tenant";

export interface SatelliteRef {
  table: string;
  db: SatelliteDb;
  /** Column holding the kind string, rewritten by the move. */
  kindCol: string;
  /** Column holding the record's id, which never changes. Used to scope. */
  idCol: string;
  /** Column holding the owning module name, when the table splits kind into
   *  module + type rather than storing "module:type" whole. */
  moduleCol?: string;
  /** True when this table stores the SHORT type ("part") beside a module
   *  column, rather than the full kind ("inventory:part"). */
  splitKind?: boolean;
}

/** Tables that point AT a record. Rewritten during a move, scoped by the
 *  record's (unchanged) id AND filtered on the old kind so a re-run after a
 *  crash between the two transactions is a no-op rather than a double-apply. */
export const SATELLITE_TABLES: SatelliteRef[] = [
  // ── meta ────────────────────────────────────────────────────────────────
  // The printed label. The token itself is untouched, so a sticker already on
  // a shelf keeps resolving; only the kind it points at is corrected.
  { table: "core_labels_qr_tokens", db: "meta", kindCol: "entity_kind", idCol: "entity_id" },
  // History stays attached and readable from the record's new home. Entry
  // PAYLOADS are not edited: what the kind was when the entry was written is
  // part of the history, not a bug.
  {
    table: "activity_log",
    db: "meta",
    kindCol: "entity_type",
    idCol: "entity_id",
    moduleCol: "module_name",
    splitKind: true,
  },
  {
    table: "notifications",
    db: "meta",
    kindCol: "entity_type",
    idCol: "entity_id",
    moduleCol: "module_name",
    splitKind: true,
  },
  // A record can sit on EITHER side of a pairing, so both sides are rewritten.
  // Missed by every hand-written draft of the satellite list.
  { table: "entity_pairings", db: "meta", kindCol: "source_kind", idCol: "source_id" },
  { table: "entity_pairings", db: "meta", kindCol: "target_kind", idCol: "target_id" },

  // ── tenant ──────────────────────────────────────────────────────────────
  // Photos and files on the record. Invisible to the first two lint regexes
  // because it uses the `source_*` convention; losing these would be the most
  // visible possible failure.
  {
    table: "core_files_attachments",
    db: "tenant",
    kindCol: "source_type",
    idCol: "source_id",
    moduleCol: "source_module",
    splitKind: true,
  },
  // The LIVE tags table (the meta-side `tag_assignments` is retired, below).
  {
    table: "core_tags_assignments",
    db: "tenant",
    kindCol: "source_type",
    idCol: "source_id",
    moduleCol: "source_module",
    splitKind: true,
  },
  // Consumption history follows the record. The ledger is the ONLY source of a
  // thing's learned cadence, so leaving it behind on a move would silently reset
  // "how fast do I go through this" to cold-start for a record the user only
  // reorganised.
  { table: "core_cadence_events", db: "tenant", kindCol: "entity_kind", idCol: "entity_id" },
  // The signal debounce follows the record too: leaving it behind would let the
  // move re-announce "running low" for something the user just reorganised.
  { table: "core_cadence_signals", db: "tenant", kindCol: "entity_kind", idCol: "entity_id" },
  {
    table: "core_maintenance_entries",
    db: "tenant",
    kindCol: "entity_type",
    idCol: "entity_id",
    moduleCol: "entity_module",
    splitKind: true,
  },
  { table: "core_devices_links", db: "tenant", kindCol: "entity_kind", idCol: "entity_id" },
  { table: "core_ai_chat_writes", db: "tenant", kindCol: "entity_kind", idCol: "entity_id" },
  { table: "core_ai_calls", db: "tenant", kindCol: "source_kind", idCol: "source_id" },
  // A committed scan still points at what it became.
  { table: "core_scan_inbox_items", db: "tenant", kindCol: "target_kind", idCol: "target_entity_id", moduleCol: "target_module" },
  { table: "labels_codes", db: "tenant", kindCol: "entity_kind", idCol: "entity_id" },
  { table: "labels_prints", db: "tenant", kindCol: "entity_type", idCol: "entity_id" },
  { table: "labels_queue", db: "tenant", kindCol: "entity_type", idCol: "entity_id" },
  // Reservations against the record survive the move.
  { table: "inventory_allocations", db: "tenant", kindCol: "target_entity_type", idCol: "target_entity_id", moduleCol: "target_module", splitKind: true },
  { table: "inventory_consumption", db: "tenant", kindCol: "source_kind", idCol: "source_id" },
  // "What this purchase became" stays answered.
  { table: "purchases_order_items", db: "tenant", kindCol: "consumed_by_entity_type", idCol: "consumed_by_entity_id", moduleCol: "consumed_by_module", splitKind: true },
  // A task blocked on this record stays blocked on it.
  { table: "projects_task_dependencies", db: "tenant", kindCol: "target_entity_type", idCol: "target_entity_id", moduleCol: "target_module", splitKind: true },
];

/** Kind-keyed tables that belong to the INSTANCE, not to any record, and are
 *  deliberately left alone. Moving one book must not drag the Bookshelf's
 *  field layout, saved views, label templates or code prefixes onto Inventory.
 *  A record arriving in a new instance adopts that instance's configuration,
 *  which is the entire point of instances being different. */
export const KIND_SCOPED_CONFIG = [
  "module_field_defs",
  "native_field_overrides",
  "field_sections",
  "entity_kind_overrides",
  "entity_action_bindings",
  "core_views_views",
  "core_templates_templates",
  "core_integrations_sync_state",
  // FALSE POSITIVE, and an instructive one: its `entity_type` is the
  // CONNECTOR's type key ("locations"), not a Cobblr entity kind, and it
  // references the record as `cobblr_entity_id`, which a move never changes.
  // Rewriting it would have corrupted sync state to fix nothing.
  "core_integrations_synced_records",
  "labels_templates",
  "labels_code_config",
  "labels_code_prefixes",
  // target_kind here is 'module' | 'instance' and target_id a module name or
  // instance slug. Not an entity kind at all; the lint matches on column NAME
  // and cannot know that, so it is declared here with the reason.
  "workspace_nav_heading_members",
  // Retired: superseded by tenant-side core_tags_assignments when core-tags
  // became a module. Still defined in the platform migration, empty, pending
  // the cleanup migration its own comment promises. Rewriting it would be
  // writing to a dead table.
  "tag_assignments",
] as const;
