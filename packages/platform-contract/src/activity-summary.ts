import { openRecordPath } from "@cobblr/platform-contract/instance-detail";

export const ACTIVITY_VERBS: Readonly<Record<string, string>> = {
  "action_predicate_overridden": "changed when you can use",
  "action_predicate_reverted": "reset when you can use",
  "add": "added",
  "added_from_scan": "scanned in",
  "ai_defaults_cleared": "cleared a personal AI for",
  "ai_defaults_set": "set a personal AI for",
  "ai_job_order_cleared": "put the workspace's AI back to automatic for",
  "ai_job_order_set": "set the workspace's AI order for",
  "ai_model_changed": "changed the AI model:",
  "allocation_consumed": "used reserved stock for",
  "allocation_released": "released reserved stock for",
  "allocation_reserved": "reserved",
  "api_token_created": "created",
  "api_token_revoked": "revoked",
  "app_mode_cleared": "cleared the setup of",
  "app_mode_set": "set up",
  "approval_approved": "approved",
  "approval_denied": "declined",
  "approval_requested": "requested",
  "asset_created": "created",
  "asset_deleted": "deleted",
  "asset_fields_updated": "updated",
  "asset_updated": "updated",
  "backup_restored": "restored",
  "blueprint_installed": "added",
  "build_completed": "finished",
  "build_created": "created",
  "build_updated": "updated",
  "bundle_features_changed": "changed the features of",
  "bundle_installed": "added",
  "bundle_reverted": "restored",
  "bundle_uninstalled": "removed",
  "bundle_word_changed": "renamed",
  "capability_granted": "granted",
  "capability_revoked": "revoked",
  "carry_replayed": "brought in their trial:",
  "catalog_created": "created",
  "catalog_updated": "updated",
  "category_created": "created",
  "created": "created",
  "custom_role_created": "created",
  "custom_role_deleted": "deleted",
  "customer_created": "created",
  "customer_deleted": "deleted",
  "customer_updated": "updated",
  "dashboard_layout_updated": "updated",
  "deleted": "deleted",
  "delivery_close_setting_changed": "changed delivery settings for",
  "document_linked": "linked a document:",
  "document_unlinked": "unlinked a document:",
  "email_change_reverted": "restored the email address for",
  "email_changed": "changed the email address for",
  "entry_created": "created",
  "entry_deleted": "deleted",
  "entry_updated": "updated",
  "secret_field_revealed": "revealed",
  "secret_field_copied": "copied",
  "secrets_exported": "exported secrets from",
  "field_def_created": "created",
  "field_def_deleted": "deleted",
  "field_def_updated": "updated",
  "file_created": "added",
  "file_deleted": "deleted",
  "file_purged": "permanently removed",
  "file_restored": "restored",
  "file_updated": "updated",
  "floorplan_imported": "imported a floor plan into",
  "focused_disabled": "turned focus off for",
  "focused_enabled": "turned focus on for",
  "folder_created": "created",
  "folder_deleted": "deleted",
  "holding_added": "added",
  "holding_split": "split",
  "holdings_combined": "combined",
  "inspection_created": "recorded",
  "instance_created": "created",
  "invite_created": "created",
  "invite_redeemed_noop": "opened an existing invitation to",
  "invite_revoked": "revoked",
  "item_created": "created",
  "item_deleted": "deleted",
  "job_created": "created",
  "instrument-reading_created": "recorded",
  "instrument-control_configured": "configured control for",
  "instrument-control_requested": "requested a supply change for",
  "instrument-control_finished": "recorded a supply change result for",
  "instrument-output_stopped": "turned off",
  "join_link_paused": "paused joining for",
  "join_link_resumed": "reopened joining for",
  "join_link_rotated": "replaced the join link for",
  "library_item_copied": "copied into Cobblr",
  "library_item_linked": "linked",
  "library_item_unlinked": "unlinked",
  "layout_applied": "applied a layout to",
  "layout_undone": "undid a layout in",
  "list_created": "created",
  "list_deleted": "deleted",
  "list_item_updated": "updated",
  "list_updated": "updated",
  "location_created": "created",
  "location_grid_lights_updated": "updated",
  "location_light_updated": "updated",
  "location_updated": "updated",
  "locations_imported": "imported places into",
  "login": "signed in",
  "machine_created": "created",
  "machine_deleted": "deleted",
  "machine_updated": "updated",
  "versions_reported": "recorded a new reported version of",
  "version_target_set": "set the version a cohort should run:",
  "make_created": "created",
  "firing_created": "created",
  "arm_set_up": "set up as a robot arm",
  "arm_versions_reported": "read new software versions from",
  "arm_program_added": "added a program to",
  "arm_program_updated": "updated a program on",
  "arm_compatibility_recorded": "recorded what works on",
  "arm_maintenance_changed": "changed the service state of",
  "arm_command": "sent a command to",
  "arm_tooling_changed": "changed the tooling on",
  "arm_control_revoked": "took station control away from",
  "arm_run_approved": "approved a run on",
  "arm_run_started": "started a run on",
  "arm_run_ended": "ended a run on",
  "arm_program_released": "released a program for production on",
  "arm_program_copied": "copied a program onto",
  "arm_copy_reteach_checked": "ticked a re-teach check on",
  "arm_copy_reteach_done": "finished re-teaching a copied program on",
  "arm_copy_cancelled": "cancelled a program copy onto",
  "arm_backed_up": "backed up",
  "arm_backup_schedule_set": "changed the backups of",
  "arm_backup_restore_tested": "tested a restore of a backup of",
  "arm_restored": "restored the programs of",
  "machine_alarm_raised": "recorded an alarm on",
  "arm_update_started": "started a guided software update on",
  "arm_update_step_checked": "ticked an update step on",
  "arm_update_verified": "verified a software update on",
  "arm_update_failed": "found a software update had not taken on",
  "arm_update_cancelled": "cancelled a software update on",
  "machine_alarm_acknowledged": "acknowledged an alarm on",
  "alarm_escalation_set": "changed who is told about alarms in",
  "cell_set_up": "set up the machines of",
  "cell_job_defined": "changed the job steps of",
  "cell_operators_set": "changed who runs",
  "cell_output_set": "changed where the parts go from",
  "cell_command": "sent a command to",
  "cell_job_ended": "closed a job on",
  "test-run_created": "prepared",
  "personal_documents_reader_changed": "changed who reads personal documents:",
  "production-test_finished": "finished testing",
  "make_deleted": "deleted",
  "measurement_created": "created",
  "member_joined": "joined",
  "member_left": "left",
  "member_removed": "removed a member from",
  "member_role_changed": "changed a member\u2019s role in",
  "phone_sign_in_code_minted": "made a phone sign-in code for",
  "phone_sign_in_code_revoked": "cancelled a phone sign-in code for",
  "metric_created": "created",
  "metric_deleted": "deleted",
  "metric_updated": "updated",
  "module_disabled": "turned off",
  "module_enabled": "turned on",
  "moved": "moved",
  "moved_by_upgrade": "moved into its own table by the upgrade:",
  "order_created": "created",
  "order_deleted": "deleted",
  "order_delivered": "received",
  "sales_document_send_started": "started emailing a quote or invoice for",
  "order_document_prepared": "prepared a document for",
  "order_emailed": "emailed the customer about",
  "outbound_email_tested": "sent a test email from",
  "order_item_added": "added",
  "order_item_claimed": "claimed an item on",
  "order_item_received": "received an item on",
  "order_item_released": "released an item on",
  "order_item_removed": "removed",
  "order_item_updated": "updated",
  "order_line_added": "added a line to",
  "order_line_changed": "changed a line on",
  "order_line_removed": "removed a line from",
  "order_make_started": "started making for",
  "order_return_recorded": "recorded a return for",
  "order_return_started": "started a return on",
  "order_shipment_added": "added a parcel to",
  "order_shipped": "shipped",
  "order_status_changed": "moved the status of",
  "order_stock_taken": "took stock for",
  "order_updated": "updated",
  "org_created": "created",
  "org_renamed": "renamed",
  "pairing_created": "linked",
  "pairing_deleted": "unlinked",
  "parcel_following_off": "stopped following",
  "parcel_following_on": "started following",
  "part_created": "created",
  "part_deleted": "deleted",
  "part_installed": "installed a part in",
  "part_removed": "took a part out of",
  "part_redated": "re-dated",
  "part_restocked": "restocked",
  "part_storage_changed": "changed storage for",
  "stock_consumed": "used components from",
  "part_updated": "updated",
  "part_used": "took one of",
  "parts_imported": "imported stock into",
  "password_changed": "changed the password for",
  "password_reset": "reset the password for",
  "password_reset_by_admin": "reset the password for",
  "person_added": "added",
  "personal_export_requested": "requested a copy of",
  "portal_config_updated": "updated",
  "project_created": "created",
  "project_copied": "copied the tasks into",
  "project_updated": "updated",
  "receipt_added_to_stock": "added stock from",
  "receipt_already_counted": "checked stock from",
  "record_brought_back": "got back",
  "record_converted": "converted",
  "record_created": "created",
  "record_deleted": "deleted",
  "record_given_away": "gave away",
  "record_gone": "marked gone",
  "record_lent": "lent out",
  "record_returned": "got back from a loan",
  "record_sent": "sent from another workspace",
  "record_handed_over": "gave you",
  "record_lost": "lost",
  "record_parted_out": "parted out",
  "record_restored": "restored",
  "record_scrapped": "disposed of",
  "record_sold": "sold",
  "record_traded": "traded",
  "record_updated": "updated",
  "repositioned": "repositioned",
  "sandbox_carried": "brought into a real account",
  "sandbox_handed_over": "started a trial in",
  "scan_committed": "scanned in",
  "scan_received": "scanned",
  "send_file_confirmed": "confirmed receipt of",
  "send_file_downloaded": "downloaded a send file for",
  "send_file_imported": "imported a send file containing",
  "sessions_revoked": "signed out all sessions for",
  "sheet_import_partly_undone": "partly undid the import of",
  "sheet_import_undone": "undid the import of",
  "sheet_imported": "imported",
  "stocktake_taken": "took stock of",
  "stocktake_undone": "undid the stocktake of",
  "recount_applied": "finished the recount of",
  "recount_undone": "undid the recount of",
  "sheet_material_updated": "updated",
  "station_created": "created",
  "station_revoked": "revoked",
  "stock_adjusted": "adjusted stock for",
  "stock_moved": "moved stock for",
  "stock_moved_all": "moved all stock for",
  "tag_attached": "tagged",
  "tag_created": "created",
  "tag_deleted": "deleted",
  "tag_detached": "took a tag off",
  "tag_merged": "merged a tag into",
  "tag_restored": "restored",
  "tag_updated": "updated",
  "task_completed": "finished",
  "task_created": "created",
  "task_updated": "updated",
  "tenant_provisioned": "set up",
  "things_handed_off": "handed over",
  "unit_added": "added",
  "term_created": "renewed",
  "updated": "updated",
  "user_created": "joined",
  "user_minted": "created an account for",
  "vendor_created": "created",
  "vendor_deleted": "deleted",
  "vendor_updated": "updated",
  "wire_created": "created",
  "wire_deleted": "deleted",
  "wire_depth_exceeded": "stopped a repeating automation in",
  "wire_disabled": "disabled",
  "wire_enabled": "enabled",
  "wire_failed": "automation failed",
  "wire_fired": "ran an automation",
  "wire_updated": "updated",
  "work-order_created": "created",
  "workspace_deletion_cancelled": "cancelled removal of",
  "workspace_deletion_scheduled": "scheduled removal of"
};

export interface ActivitySubject {
  href: string;
  title: string;
  kind: string | null;
  id: string;
  thumbnail: string | null;
}
export interface SummaryEntry {
  action: string;
  entity_type: string;
  entity_id: string;
  module_name: string | null;
  user_id?: string | null;
  actor?: { id?: string; display_name: string | null; email?: string | null } | null;
  via_kind?: string | null;
  via_label?: string | null;
  diff: unknown;
  entity_title?: string | null;
  entity_kind?: string | null;
  said?: readonly { label: string }[];
}
export interface ActivityPresentation {
  summary: string;
  template: string;
  verb: string;
  subject: ActivitySubject;
  hidden: boolean;
}
const bag = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const named = (d: Record<string, unknown>): string | null => text(d.name) ?? text(d.title) ?? text(d.label) ?? text(d.display_name) ?? text(d.document) ?? text(d.item);
/** The outside system a row's change came from, by its own name ("Workshop
 *  OS"), when an integration's sync made it. A row from before the sync had
 *  its own kind says "<source> sync" as an automation; it reads the same
 *  (#6564: "Homebox sync updated 47 locations: …" beside a letter tile). */
export function activitySyncSource(e: Pick<SummaryEntry, "via_kind" | "via_label">): string | null {
  if (e.via_kind === "sync") return text(e.via_label) ?? "A sync";
  if (e.via_kind === "automation") {
    const m = /^(.+?)\s+sync$/i.exec(text(e.via_label) ?? "");
    if (m) return m[1]!;
  }
  return null;
}

export function activityActor(e: SummaryEntry, viewerId?: string): string {
  if (viewerId && (e.user_id === viewerId || e.actor?.id === viewerId)) return "You";
  if (e.actor) return text(e.actor.display_name) ?? text(e.actor.email) ?? "A former member";
  if (e.user_id) return "A former member";
  if (e.via_kind === "share") return text(e.via_label) ?? "Someone you share with";
  const sync = activitySyncSource(e);
  if (sync) return sync;
  if (e.via_kind === "automation") return text(e.via_label) ?? "An automation";
  return "Cobblr";
}

/** What a row is about when nothing names it (its record gone, or one the
 *  reader may not see): words a person uses, never the stored kind (#5906:
 *  "reserved allocation", "turned on org_module", "linked pairing"). One
 *  table; a kind it does not list is "a record". The stored type never
 *  reaches a sentence, which a-row-never-says-its-stored-kind.test.ts holds. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  membership: "the workspace",
  org: "the workspace",
  user: "an account",
  org_module: "an app",
  allocation: "a reservation",
  pairing: "a link",
  workspace_link: "a link to another workspace",
  api_token: "an API token",
  invite: "an invitation",
  binding: "a connection",
  bundle: "a collection",
  approval_request: "a request for approval",
  send: "a sent file",
  field_def: "a field",
  workspace_role: "a role",
  person: "someone",
  carry: "a trial's records",
  action: "an action",
  service_job: "a service job",
  sandbox: "a sandbox",
  personal_documents_reader: "personal documents",
  instance: "a collection",
  blueprint: "a blueprint",
  backup: "a backup",
  "ai-model": "an AI model",
  ai_job_order: "the AI job order",
  ai_job_defaults: "the AI defaults",
  wire: "an automation",
  tag: "a tag",
  file: "a file",
};
export const kindWords = (entityType: string): string => KIND_WORDS[entityType] ?? "a record";

export function activityPresentation(e: SummaryEntry, slug: string, viewerId?: string, resolved?: ActivitySubject): ActivityPresentation {
  const d = bag(e.diff);
  const actor = activityActor(e, viewerId);
  let title = named(d) ?? e.entity_title ?? kindWords(e.entity_type);
  const kind = e.entity_kind ?? (e.module_name ? `${e.module_name}:${e.entity_type}` : null);
  let subject: ActivitySubject = resolved ?? { title, kind, id: e.entity_id, thumbnail: null,
    href: `/w/${encodeURIComponent(slug)}${kind ? openRecordPath(kind, e.entity_id) : "/activity"}` };
  let summary: string;
  let template = e.action;
  let verb = ACTIVITY_VERBS[e.action] ?? "changed";
  let hidden = false;
  if (e.action === "secret_field_revealed" || e.action === "secret_field_copied") {
    summary = `${actor} ${verb} the ${(text(d.field_label) ?? "secret").toLowerCase()}`;
  } else if (e.action === "wire_fired" || e.action === "wire_failed") {
    const said = text(d.said);
    const label = text(d.action_label) ?? "An automation";
    hidden = e.action === "wire_fired" && (d.declined === true || d.changed === 0 || !said);
    summary = e.action === "wire_failed" ? `${label} failed${text(d.error) ? `: ${text(d.error)}` : ""}` : said ? `${label}: ${said}` : `${label} changed nothing`;
    if (!resolved) subject = { ...subject, title: label, href: `/w/${encodeURIComponent(slug)}/wires` };
  } else if (e.action.startsWith("bundle_")) {
    summary = e.action === "bundle_installed" ? e.user_id || e.actor ? `${actor} added the ${title} collection` : `Set up for you: ${title}` : `${actor} ${ACTIVITY_VERBS[e.action] ?? "changed"} ${title}`;
    subject = { ...subject, href: `/w/${encodeURIComponent(slug)}/bundles` };
  } else if (e.action === "send_file_downloaded" || e.action === "send_file_imported" || e.action === "send_file_confirmed") {
    title = typeof d.items === "number" && Number.isInteger(d.items) && d.items > 0 ? `${d.items} ${d.items === 1 ? "item" : "items"}` : "items";
    summary = `${actor} ${verb} ${title}`;
    subject = {...subject, kind: null, href: `/w/${encodeURIComponent(slug)}/configuration/sharing`};
  } else if (e.action === "stocktake_taken" || e.action === "stocktake_undone") {
    // One line for the whole run, never one per record: it says the counts
    // and opens the stocktake, where its Undo is.
    const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
    summary = e.action === "stocktake_taken"
      ? `${actor} took stock of ${title}: ${n(d.kept)} kept, ${n(d.gone)} marked gone`
      : `${actor} undid the stocktake of ${title}`;
    if (!resolved) subject = { ...subject, kind: null, href: `/w/${encodeURIComponent(slug)}/stocktakes/${encodeURIComponent(e.entity_id)}` };
  } else if (e.action === "recount_applied" || e.action === "recount_undone") {
    // One line for the whole recount (#6302), never one per record: it says
    // what changed and opens the recount, where its Undo is.
    const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
    const said = [
      n(d.moved) ? `${n(d.moved)} moved` : null,
      n(d.counted) ? `${n(d.counted)} recounted` : null,
      n(d.added) ? `${n(d.added)} added` : null,
      n(d.gone) ? `${n(d.gone)} marked gone` : null,
    ].filter(Boolean).join(", ");
    summary = e.action === "recount_applied"
      ? `${actor} finished the recount of ${title}: ${n(d.seen)} seen${said ? `, ${said}` : ""}`
      : `${actor} undid the recount of ${title}`;
    const collection = text(d.collection) ?? "inventory";
    const base = collection === "inventory" ? "inventory" : `instances/${encodeURIComponent(collection)}`;
    if (!resolved) subject = { ...subject, kind: null, href: `/w/${encodeURIComponent(slug)}/${base}/recounts/${encodeURIComponent(e.entity_id)}` };
  } else if (e.action === "part_redated" && text(d.said)) {
    // Why a date moved, in the row itself: "Strawberries moved to the fridge: good until 2026-10-24".
    summary = `${title} ${text(d.said)}`;
  } else if (e.action === "record_sent") {
    verb = "sent";
    summary = `Sent from ${text(d.from) ?? "another workspace"} by ${actor}: ${title}`;
  } else if (e.action === "file_created") {
    const scan = bag(d.scan);
    const record = bag(d.record);
    if (text(scan.id)) {
      title = text(scan.name) ?? text(scan.barcode) ?? "a photo";
      template = "file_created:scan"; verb = "scanned";
      summary = `${actor} scanned ${title}`;
    } else if (text(record.name)) {
      title = text(record.name)!;
      const noun = text(d.kind) && d.kind !== "image" ? "file" : "photo";
      template = `file_created:${noun}`; verb = `added a ${noun} to`;
      summary = `${actor} ${verb} ${title}`;
    } else {
      const code = /^scan-(\d+)\.[a-z0-9]+$/i.exec(title)?.[1];
      if (code) { template = "file_created:scan"; verb = "scanned"; title = code; summary = `${actor} scanned ${code}`; }
      else summary = `${actor} added ${d.kind === "image" ? "a photo" : title}`;
    }
    if (!resolved) subject = { ...subject, title, href: `/w/${encodeURIComponent(slug)}/files/${encodeURIComponent(e.entity_id)}` };
  } else if (e.action === "scan_received") {
    // Named by the row now (the namer's context), never its barcode while a
    // name exists: "You scanned Kirkland Signature Organic Cane Sugar".
    const scan = bag(d.scan);
    title = text(scan.name) ?? text(d.barcode) ?? "a thing";
    summary = `${actor} scanned ${title}`;
    if (!resolved) subject = { ...subject, title, href: `/w/${encodeURIComponent(slug)}/scan?item=${encodeURIComponent(e.entity_id)}` };
  } else if (e.action === "scan_committed" || e.action === "added_from_scan") {
    title = named(d) ?? text(d.barcode) ?? e.entity_title ?? "a thing";
    summary = `${actor} scanned in ${title}`;
    if (!resolved) subject = { ...subject, title, href: `/w/${encodeURIComponent(slug)}/scan` };
  } else if (e.action === "module_enabled" && !e.user_id && !e.actor) {
    summary = `Set up for you: ${title}`;
  } else if (e.action === "user_created" || e.action === "member_joined") {
    // The subject is the workspace they joined, never the account record.
    title = e.entity_title ?? "the workspace";
    summary = `${actor} joined ${title}`;
  } else if (e.action === "updated" || e.action.endsWith("_updated")) {
    const fields = [...new Set((e.said ?? []).map(c => c.label.toLowerCase()))];
    const labels = fields.slice(0, 2).join(" and ") + (fields.length > 2 ? ` +${fields.length - 2} more` : "");
    summary = `${actor} updated ${labels ? `${labels} on ` : ""}${title}`;
  } else {
    summary = `${actor} ${ACTIVITY_VERBS[e.action] ?? "changed"} ${title}`;
  }
  return { summary, template, verb, subject: { ...subject, title: e.action === "wire_fired" || e.action === "wire_failed" ? subject.title : title }, hidden };
}

export function dedupeActivity<T extends { action: string; entity_id: string; module_name: string | null; user_id: string | null; occurred_at: string; summary?: string; diff: unknown; repeats?: number }>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    const same = last && last.action === row.action && last.module_name === row.module_name && last.entity_id === row.entity_id && last.user_id === row.user_id && last.summary === row.summary && JSON.stringify(last.diff) === JSON.stringify(row.diff) && Math.abs(Date.parse(last.occurred_at) - Date.parse(row.occurred_at)) <= 120_000;
    if (same) last.repeats = (last.repeats ?? 1) + 1;
    else out.push({ ...row });
  }
  return out;
}
