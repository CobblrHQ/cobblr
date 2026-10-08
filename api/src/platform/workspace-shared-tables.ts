// Every table in the shared platform database that holds a workspace's rows
// (it carries an `org_id`), and what a backup does with it.
//
// A workspace lives in two places: its own database, which a backup dumps
// whole, and rows keyed by `org_id` in the shared one. The backup used to read
// only the first, so a workspace restored from it came back with every record
// and none of the links between them, none of its people, field sections,
// menu headings or printed-label tokens, and nothing said so (the 2026-09
// fundamentals audit). This list is where each shared table's answer lives,
// and `lint:backup-covers-shared-tables` refuses a table that has none, so a
// new one cannot be missed the same way.
//
//   backup     copied into the archive (platform/<table>.jsonl) and restored
//              into the target workspace, replacing its rows
//   blueprint  carried by the Blueprint inside every backup (captureBlueprint)
//   never      deliberately left out, with the reason a person would accept
//
// Order matters for `backup` tables: a table is restored after the tables its
// rows point at (field sections before the overrides that name them), and
// cleared in the reverse order.
//
// Keep this file free of imports: the lint loads it directly.

export interface BackupTable {
  travels: "backup";
  /** The uuid primary key. A restore gives each row a new one (the source
   *  workspace may still hold the old), and swaps old for new everywhere the
   *  workspace's data mentions it, the way file ids are swapped. */
  id?: string;
  /** Columns naming a user account. Kept only when that person is a member of
   *  the workspace the backup lands in; otherwise cleared, because a backup
   *  never tells one workspace about another's members. */
  users?: string[];
  /** Columns that never travel: a serial id the target numbers itself, or a
   *  reference to something a backup does not carry. */
  drop?: string[];
  /** Why a row may be refused on restore without it being a failure. */
  mayRefuse?: string;
}
export interface BlueprintTable {
  travels: "blueprint";
}
export interface NeverTable {
  travels: "never";
  why: string;
}
export type SharedTablePolicy = BackupTable | BlueprintTable | NeverTable;

const ACCESS = "who may enter a workspace is decided where the backup lands; a backup never grants anyone access";
const CREDENTIAL = "a credential or key; it is issued again where it is used, never copied";
const PERSONAL = "one person's own inbox and choices, tied to accounts the target workspace may not have";

export const SHARED_WORKSPACE_TABLES: Record<string, SharedTablePolicy> = {
  record_action_layouts: { travels: "backup" },
  record_action_pins: { travels: "never", why: PERSONAL },
  push_subscriptions: { travels: "never", why: "a browser on one device, subscribed to this server's own push key; restored elsewhere it is a key that server cannot sign for, so a device turns notifications on again there" },
  deleted_records: { travels: "never", why: "deleted before-images expire in the workspace where the deletion happened" },
  // ── Restored with the backup (order: parents first) ────────────────────
  workspace_people: { travels: "backup", id: "id", users: ["user_id"] },
  entity_pairings: { travels: "backup", id: "id", users: ["created_by"] },
  scan_tag_aliases: { travels: "backup" },
  field_sections: { travels: "backup", id: "id" },
  native_field_overrides: { travels: "backup", id: "id", drop: ["bundle_id"] },
  entity_kind_overrides: { travels: "backup", id: "id" },
  workspace_field_scopes: { travels: "backup", id: "id", users: ["created_by"] },
  workspace_nav_headings: { travels: "backup", id: "id" },
  workspace_nav_heading_members: { travels: "backup", id: "id" },
  entity_action_org_overrides: {
    travels: "backup",
    users: ["updated_by"],
    mayRefuse: "an override of an action this build no longer has",
  },
  service_capability_policies: { travels: "backup", users: ["updated_by"] },
  // An offer to reshape a kind's fields and its answer ("keep sellers as
  // notes"): a restored workspace is not asked again what it already said.
  field_upgrade_offers: { travels: "backup" },
  operator_sandboxes: { travels: "never", why: "the operator's audit of a sandbox made from the box; it outlives the sandbox, and a backup of the sandbox is not that operator's record" },
  service_job_cards: { travels: "never", why: "cards a running job already sent to people; the jobs they belong to do not travel" },
  service_pending_confirms: { travels: "never", why: "a running job waiting for a yes; the job does not travel, so neither does its question" },
  service_confirm_triggers: { travels: "never", why: "a yes given to one waiting job ahead of its moment; the job does not travel, and a yes never becomes a standing permission somewhere else" },
  service_watched_jobs: { travels: "never", why: "the supervisor's list of jobs still moving; the jobs do not travel, and a restored workspace starts with nothing running" },
  core_recurrence_entity_state: { travels: "backup" },
  core_labels_qr_tokens: {
    travels: "backup",
    id: "id",
    mayRefuse: "a printed label still held by the workspace the backup came from; a label resolves to one workspace",
  },
  ravelry_imports: { travels: "backup" },
  activity_log: { travels: "backup", users: ["user_id"], drop: ["id", "api_token_id"] },

  // ── Carried by the Blueprint ──────────────────────────────────────────
  org_modules: { travels: "blueprint" },
  workspace_module_instances: { travels: "blueprint" },
  bundles: { travels: "blueprint" },
  bundle_resource_claims: { travels: "blueprint" },
  module_field_defs: { travels: "blueprint" },
  entity_action_bindings: { travels: "blueprint" },

  // ── Never ─────────────────────────────────────────────────────────────
  tidy_suggestions: { travels: "never", why: "pending suggestions are found afresh on the restored workspace" },
  tidy_suppressions: { travels: "never", why: "suggestion preferences belong to this workspace; restored workspaces start opted out" },
  tidy_route_cache: { travels: "never", why: "routing results are derived from the current workspace's collections" },
  warranty_reminder_deliveries: { travels: "never", why: "reminders already sent to accounts on this instance; a restored workspace sends its own reminders" },
  low_stock_alert_deliveries: { travels: "never", why: "daily notices already sent to accounts on this instance; a restored workspace sends its own notices" },
  org_memberships: { travels: "never", why: ACCESS },
  workspace_invites: { travels: "never", why: ACCESS },
  workspace_roles: { travels: "never", why: ACCESS },
  workspace_role_assignments: { travels: "never", why: ACCESS },
  workspace_capability_grants: { travels: "never", why: ACCESS },
  approval_requests: { travels: "never", why: "a request to a person in this workspace; it lapses rather than travels" },
  ai_held_changes: { travels: "never", why: "a change an assistant asked for, waiting on a person in this workspace; it lapses in a day and never replays somewhere else" },
  issued_undos: { travels: "never", why: "an undo step handed to one person for their own run; it is theirs for a week and means nothing in another workspace" },
  notifications: { travels: "never", why: PERSONAL },
  notification_subscriptions: { travels: "never", why: PERSONAL },
  notification_deferred: { travels: "never", why: PERSONAL },
  notification_audiences: { travels: "never", why: PERSONAL },
  share_links: { travels: "never", why: "a pairing with another workspace, holding the keys both sides sign with; a restored workspace shares again by inviting again" },
  share_view_sessions: { travels: "never", why: "read-only View as grants through a share's pairing, minutes long; a restored workspace has no pairing until it shares again" },
  share_additions: { travels: "never", why: "things a friend added through a share, which belong to that share's pairing; a restored workspace has no pairing until it shares again" },
  share_suggestions: { travels: "never", why: "a friend's edits through a share, which belong to that share's pairing; a restored workspace has no pairing until it shares again" },
  api_tokens: { travels: "never", why: CREDENTIAL },
  oauth_grants: { travels: "never", why: CREDENTIAL },
  oauth_codes: { travels: "never", why: CREDENTIAL },
  org_encryption_keys: { travels: "never", why: CREDENTIAL },
  integration_inbound_token_lookup: { travels: "never", why: CREDENTIAL },
  user_credential_orgs: { travels: "never", why: CREDENTIAL },
  // The workspace's own outbound email: its provider settings and keys.
  org_outbound_email: { travels: "never", why: CREDENTIAL },
  outbound_email_log: {
    travels: "never",
    why: "this instance's record of what it mailed; each order's own history, which the backup carries, keeps who was emailed and when",
  },
  browser_drive_grants: { travels: "never", why: CREDENTIAL },
  scan_stations: { travels: "never", why: "a physical station paired to one person's token; pair it again after restoring so queued scans cannot run in another workspace" },
  edge_pairing_codes: { travels: "never", why: CREDENTIAL },
  public_surface_tokens: {
    travels: "never",
    why: "a share link is a credential; the Blueprint recreates the surface and it gets a new link",
  },
  calendar_feeds: { travels: "never", why: "a calendar feed address is a credential; turn the feed on again after a restore" },
  backup_destinations: { travels: "never", why: "where backups are sent, with its credentials; set up on the workspace itself" },
  edge_driver_packages: {
    travels: "never",
    why: "belongs to the edge bridges paired with this workspace; they pair again with a restored one",
  },
  core_queue_jobs: { travels: "never", why: "background work in flight; the restored workspace schedules its own" },
  inbound_emails: { travels: "never", why: "the raw mail kept for reprocessing; what it became travels as records" },
  bundle_snapshots: { travels: "never", why: "an undo point for one bundle removal in this workspace" },
  tags: { travels: "never", why: "retired: tags live in core-tags' tables in the workspace's own database" },
  feedback: { travels: "never", why: "what the workspace's people told the operator, not the workspace's data" },
  product_events: { travels: "never", why: "the operator's usage counts, not the workspace's data" },
  product_daily_counts: { travels: "never", why: "the operator's usage counts, not the workspace's data" },
  impersonation_sessions: { travels: "never", why: "the operator's audit of support sessions" },
  test_org_pool: { travels: "never", why: "test infrastructure" },
  try_sandbox_tokens: { travels: "never", why: "try-it sandbox bookkeeping" },
  try_sandbox_exports: { travels: "never", why: "try-it sandbox bookkeeping" },
  try_carry_tokens: { travels: "never", why: "try-it sandbox bookkeeping" },
  workspace_final_exports: { travels: "never", why: "the last backup of a deleted workspace, kept for its owners after the workspace is gone" },
  try_keep_joins: { travels: "never", why: "try-it sandbox bookkeeping: a pending link to join an account" },
};

export const BACKUP_TABLES: Array<[string, BackupTable]> = Object.entries(SHARED_WORKSPACE_TABLES).filter(
  (e): e is [string, BackupTable] => e[1].travels === "backup",
);
