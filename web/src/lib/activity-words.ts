import { productName } from "@cobblr/platform-web";
import { ACTIVITY_VERBS, activitySyncSource, dedupeActivity } from "@cobblr/platform-contract/activity-summary";
import type { ActivityEntry, SaidChange } from "./api";
// What a Recent-activity row says, in words a first-timer can read.
//
// The first screen a stranger met read "Automation ran an automation
// core-scan.scan.received → identify-photo" twice, and "updated type" (#3299):
// three of six rows were event ids and reactor names in monospace, and on a
// phone the truncation landed on "ran an automation core-scan...." which reads
// as an error. A wire's row now carries the action's own sentence for what it
// did (`said`, the result's summary) and its declared label (`action_label`),
// written by the module; this turns those into the row's words and never
// prints an id. A row that has no words at all (an older row, an action the
// registry no longer knows) is not shown on the dashboard: it belongs to the
// full /activity log, where an operator reads ids on purpose.
//
// Pure, so the rule is tested without a browser, and so lint:ui-jargon can
// hold the surface to it: an event id or an action id printed as text is the
// offense it already names for kind ids.

export interface ActivityWordsEntry {
  action: string;
  entity_type: string;
  module_name: string | null;
  diff: unknown | null;
  entity_title?: string | null;
  entity_kind?: string | null;
  actor: { display_name: string | null; email?: string | null } | null;
  /** How the actor signed in, the token it used, and HOW the write was made
   *  (#3833). Optional so an older payload still types. */
  auth_method?: "session" | "api_token" | "system";
  token?: { name: string } | null;
  via_kind?: string | null;
  via_label?: string | null;
}

export const AUTOMATION_ACTIONS: ReadonlySet<string> = new Set(["wire_fired", "wire_failed"]);

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Who to credit a row to, and never "someone" (#3833): the person; else an
 *  automation (a wire's own row, or a write an automation made with nobody
 *  behind it); else the platform itself ("Cobblr": an automatic bundle
 *  update, a boot-time repair). A member whose account is gone is still a
 *  member: "A former member", not a blank. */
export function actorWords(e: ActivityWordsEntry): string {
  if (e.actor) return e.actor.display_name ?? e.actor.email ?? "A former member";
  // A friend's edit from a share space: they are not a member here, and the
  // row names them.
  if (e.via_kind === "share") return str(e.via_label) ?? "Someone you share with";
  // An integration's sync, by the source's own name ("Homebox"), and a
  // row from before the sync had its own kind ("Homebox sync") alike.
  const sync = activitySyncSource(e);
  if (sync) return sync;
  if (AUTOMATION_ACTIONS.has(e.action) || e.via_kind === "automation") return "Automation";
  return productName();
}

/** HOW the row's actor acted, as the chip beside the name, or null for a
 *  plain hand edit. One rule for the dashboard feed and the Activity page:
 *  the dashboard used to show no token at all, so an assistant's edits over
 *  MCP read exactly like the owner's own while the Activity page named the
 *  token (#3833). */
export function viaWords(e: ActivityWordsEntry): string | null {
  const token = e.token?.name ?? null;
  const label = str(e.via_label);
  switch (e.via_kind) {
    case "mcp":
      return token ? `via MCP · ${token}` : "via MCP";
    case "assistant":
      return "via Cobb";
    case "sync":
      // The source is already the actor ("Homebox"): nothing to add.
      return null;
    case "automation":
      // With nobody behind it, the actor already reads "Automation": the chip
      // names which one. A sync's old rows name their source as the actor.
      if (!e.actor && activitySyncSource(e)) return null;
      if (!e.actor) return label ? `“${label}”` : null;
      return label ? `via automation “${label}”` : "via automation";
    case "label":
      // A scanned action label: the person pressed it, the label is how.
      return label ? `via label “${label}”` : "via a label";
    case "surface":
      // A place in the app that is not the record's page: "via floor plan".
      return label ? `via ${label}` : null;
    case "share":
      return "through your share";
  }
  if (e.auth_method === "api_token") return token ? `via ${token}` : "via API";
  return null;
}

/** The chip for a GROUP of rows ("updated 8 3D printers"): the shared via
 *  when every row has the same one, "mixed" when they differ, null when none
 *  of them has one. */
export function groupViaWords(entries: readonly ActivityWordsEntry[]): string | null {
  const vias = entries.map(viaWords);
  if (vias.every((v) => v === null)) return null;
  const first = vias[0] ?? null;
  return vias.every((v) => v === first) ? first : "mixed";
}

/** The row for a wire that fired or failed: `{ said }` in words, or
 *  `{ hidden: true }` when the row has no words a member should read (an
 *  older row that carries only ids; an action that found nothing to do,
 *  which is not news; a row whose only content is an event id). */
export function automationWords(e: ActivityWordsEntry): { said: string; label: string | null; hidden: false } | { hidden: true } {
  const d = (e.diff ?? {}) as Record<string, unknown>;
  const label = str(d.action_label);
  if (e.action === "wire_failed") {
    if (!label) return { hidden: true };
    const error = str(d.error);
    return { said: error ? `${label} failed: ${error}` : `${label} failed`, label, hidden: false };
  }
  if (d.declined === true) return { hidden: true };
  const said = str(d.said);
  if (said) return { said, label, hidden: false };
  if (label) return { said: `ran “${label}”`, label, hidden: false };
  return { hidden: true };
}

/** An update's words: the fields it changed under their labels, with the new
 *  value in words, as the api said them (history-describe.ts), two at most.
 *  Never a column name or a raw value: "purchase price cents → 430000" and
 *  "image path → /api/v1/…" were exactly that (#4517). */
export function updatedFieldsWords(said: SaidChange[] | undefined): string | null {
  const out = (said ?? []).slice(0, 2).map((c) => (c.to.photo || c.field === "image_path" ? "a new photo" : `${c.label} → ${c.to.text ?? "(empty)"}`));
  return out.length ? out.join(", ") : null;
}

/** True when the row is one the dashboard should not show at all. */
export function hiddenFromDashboard(e: ActivityWordsEntry): boolean {
  return AUTOMATION_ACTIONS.has(e.action) && automationWords(e).hidden;
}

/** On the record's own history, a part installed in it or taken out of it
 *  says which: "installed 2 × RAM stick", "took out SSD 2TB". Null for any
 *  other row. */
export function partWords(action: string, diff: unknown, word?: string | null): { verb: string; what: string } | null {
  if (action !== "part_installed" && action !== "part_removed") return null;
  const d = (diff ?? {}) as { part?: { name?: unknown }; qty?: unknown };
  const name = typeof d.part?.name === "string" && d.part.name ? d.part.name : "a part";
  const qty = typeof d.qty === "number" && d.qty !== 1 ? `${d.qty} × ` : "";
  // The kind's own word for what is inside ("Parts"), when it has one.
  if (word) {
    return action === "part_installed" ? { verb: "added", what: `${qty}${name} to ${word}` } : { verb: "took", what: `${qty}${name} out of ${word}` };
  }
  return { verb: action === "part_installed" ? "installed" : "took out", what: `${qty}${name}` };
}

/** The feed's own sentences for actions, ahead of the platform's table. */
export const FEED_VERBS: Readonly<Record<string, string>> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  login: "signed in",
  user_created: "joined",
  pairing_created: "linked",
  pairing_deleted: "unlinked",
  // A boot pass moved the record to the table its fields belong to (the
  // Groceries base-kind twin, 2026-09-13); the row says so, not "system".
  moved_by_upgrade: "moved into its own table by the upgrade:",
  // "ran a wire" read as jargon to a new user (2026-09-12): the row is
  // "<actor> <verb> <event -> action>", so the verb says what happened.
  wire_fired: "ran an automation",
  wire_failed: "automation failed",
  // A trial brought in from the demo box; the row's title is the trial's name.
  carry_replayed: "brought in their trial:",
  // Which model the AI uses moved: a family's latest found a newer model,
  // a retired pin healed, or the upgrade to "latest" (#5417). The row's
  // title is the sentence that says which.
  ai_model_changed: "changed the AI model:",
  // One thing added from a scan, its create and follow-up rows folded in
  // (foldOneThingsRows).
  added_from_scan: "scanned in",
  // A thing built from parts: logged on the computer (or machine) itself.
  part_installed: "installed a part in",
  part_removed: "took a part out of",
  // One-tap stock changes (a button, or a scanned action label).
  part_used: "took one of",
  part_restocked: "restocked",
  stock_consumed: "used components from",
  part_storage_changed: "changed storage for",
  // A spreadsheet import is one row for the whole run; its title is the file.
  sheet_imported: "imported",
  // A stocktake is one row for the whole run; its title is the place.
  stocktake_taken: "took stock of",
  stocktake_undone: "undid the stocktake of",
  recount_applied: "finished the recount of",
  recount_undone: "undid the recount of",
  record_gone: "marked gone",
  // A thing that left, and came back (platform:mark-gone / bring-back).
  record_sold: "sold",
  record_given_away: "gave away",
  record_parted_out: "parted out",
  record_converted: "converted",
  record_traded: "traded",
  record_lost: "lost",
  record_scrapped: "disposed of",
  record_brought_back: "got back",
  // A thing lent out, and back (platform:lend / return, #6335).
  record_lent: "lent out",
  record_returned: "got back from a loan",
  // A thing handed over through a share, filed: the friend gave it (#4683).
  record_sent: "sent from another workspace",
  record_handed_over: "gave you",
  sheet_import_undone: "undid the import of",
  sheet_import_partly_undone: "partly undid the import of",
  // Tags. An attach or detach is logged on the record that was tagged, so
  // the row names that record.
  tag_attached: "tagged",
  tag_detached: "took a tag off",
  tag_merged: "merged a tag into",
  // A sales order's own changes (orderHappened).
  order_status_changed: "moved the status of",
  order_line_added: "added a line to",
  order_line_changed: "changed a line on",
  order_line_removed: "removed a line from",
  order_stock_taken: "took stock for",
  order_shipped: "shipped",
  order_emailed: "emailed the customer about",
  order_make_started: "started making for",
  // A purchase order's parcel, on the order's own history (#5351).
  order_shipment_added: "added a parcel",
  // A document from a document system (core-documents); the row says which
  // (documentWords).
  document_linked: "linked a document:",
  document_unlinked: "unlinked a document:",
  // An item from an outside library (a document, a game); the row names it
  // (documentWords).
  library_item_linked: "linked",
  library_item_unlinked: "unlinked",
  library_item_copied: `copied into ${productName()}`,
};

/** The verb a feed row puts between who and what: one map for every feed
 *  (the dashboard's recent activity and the account's own log each kept a
 *  copy, and they had drifted: only one knew what an automation row says). */
export function activityVerb(a: string): string {
  const map = FEED_VERBS;
  if (map[a]) return map[a];
  // A module that named its action the way it names events
  // ("core-documents.linked") would otherwise read as code on the page: the
  // verb is its last word.
  const verb = a.includes(".") ? a.slice(a.lastIndexOf(".") + 1) : a;
  if (map[verb]) return map[verb];
  // The platform's sentence table, which every module's activity is held to
  // (every-activity-event-has-a-readable-sentence): a row this map does not
  // know still reads as its module wrote it, never as "order shipment added".
  if (ACTIVITY_VERBS[verb]) return ACTIVITY_VERBS[verb];
  // 'task_created' → 'created task' (the entity_type is already
  // rendered on the row, so we just need the verb).
  if (verb.endsWith("_created")) return "created";
  if (verb.endsWith("_updated")) return "updated";
  if (verb.endsWith("_deleted")) return "deleted";
  return verb.replace(/[_-]/g, " ");
}

/** The verb on a record's OWN history, where the record is the page and so
 *  the row leaves its name out: a verb that ends on a preposition would
 *  dangle ("Sam applied a layout to", #5530), so it ends before it
 *  ("Sam applied a layout"). */
export function ownHistoryVerb(a: string): string {
  return activityVerb(a)
    .replace(/\s+out of$/, " out")
    .replace(/\s+(?:into|onto|from|about|to|of|in|on|for|with|at)$/, "");
}

/** The document a document row is about, by its title (core-documents logs
 *  it in the diff), or null for any other row. */
export function documentWords(e: { action: string; diff?: unknown }): string | null {
  const d = (e.diff ?? {}) as { document?: unknown; item?: unknown };
  const named = e.action === "document_linked" || e.action === "document_unlinked" ? d.document : e.action === "library_item_linked" || e.action === "library_item_unlinked" || e.action === "library_item_copied" ? d.item : null;
  return typeof named === "string" && named.trim() ? named.trim() : null;
}

/** The record a row is about. A scan's commit row is about its inbox item,
 *  and names the record it made in `diff.entity_id`. */
function recordOf(e: { action: string; entity_id: string; diff: unknown }): string {
  if (e.action === "scan_committed" && e.diff && typeof e.diff === "object") {
    const made = (e.diff as Record<string, unknown>).entity_id;
    if (typeof made === "string" && made) return made;
  }
  return e.entity_id;
}

/** How close together two rows must be to count as one act. */
const ONE_ACT_MS = 2 * 60_000;

/** One act, one row. Filing a scan writes three rows (the scan committed, the
 *  record created, then updated with its place and photo), and the dashboard
 *  showed all three for one grocery (#4147). Consecutive rows by the same
 *  person about the same record within two minutes fold into one: the create,
 *  said as "scanned in" when a scan made it. The full activity log keeps
 *  every row; this is only what the dashboard shows. */
export function foldOneThingsRows<T extends { action: string; entity_id: string; entity_type: string; diff: unknown; occurred_at: string; user_id: string | null; summary?: string; template?: string }>(items: T[]): T[] {
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]!);
    } else {
      const scanned = run.some((e) => e.action === "scan_committed");
      const made = run.find((e) => e.action === "created" || e.action.endsWith("_created"));
      const rep = made ?? run.find((e) => e.action !== "scan_committed") ?? run[0]!;
      // The row opens the record the scan made, in the scan's own words
      // ("Sam scanned in Oat milk"), not the create's ("Sam created Oat milk").
      const scan = run.find((e) => e.action === "scan_committed");
      out.push(scanned && made ? { ...rep, action: "added_from_scan", template: "added_from_scan", summary: scan?.summary ?? rep.summary } : rep);
    }
    run = [];
  };
  for (const e of items) {
    const head = run[0];
    const sameAct =
      head &&
      head.user_id === e.user_id &&
      recordOf(head) === recordOf(e) &&
      Math.abs(Date.parse(head.occurred_at) - Date.parse(e.occurred_at)) <= ONE_ACT_MS;
    if (!sameAct) flush();
    run.push(e);
  }
  flush();
  return out;
}

/** Rows that are plumbing, not things a member did: a module switched on, the
 *  workspace itself, a sign-in. The full /activity log keeps them. */
const DASHBOARD_NOISE = new Set(["org_module", "org", "user", "tenant"]);

/** What the dashboard's recent activity shows, in order: no plumbing or
 *  wordless rows (#3299), one row per act (a scan's three rows are one,
 *  #4147), and a repeat said once with its count. One function, so a rewrite
 *  of the card cannot drop a step and leave its test green on a helper. */
export function recentActivityRows(items: readonly ActivityEntry[]): ActivityEntry[] {
  const shown = items.filter((e) => !DASHBOARD_NOISE.has(e.entity_type ?? "") && !e.hidden && !hiddenFromDashboard(e));
  return dedupeActivity(foldOneThingsRows(shown));
}
