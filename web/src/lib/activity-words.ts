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
  if (AUTOMATION_ACTIONS.has(e.action) || e.via_kind === "automation") return "Automation";
  return "Cobblr";
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
    case "automation":
      // With nobody behind it, the actor already reads "Automation": the chip
      // names which one.
      if (!e.actor) return label ? `“${label}”` : null;
      return label ? `via automation “${label}”` : "via automation";
    case "label":
      // A scanned action label: the person pressed it, the label is how.
      return label ? `via label “${label}”` : "via a label";
    case "surface":
      // A place in the app that is not the record's page: "via floor plan".
      return label ? `via ${label}` : null;
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

/** An update's words when the record's live title could not be read: name
 *  the field and the value that changed rather than a bare noun ("updated
 *  type" read as a bug: updated what type?). Scalars only, two at most. */
export function updatedFieldsWords(diff: unknown): string | null {
  if (!diff || typeof diff !== "object") return null;
  const out: string[] = [];
  for (const [k, v] of Object.entries(diff as Record<string, unknown>)) {
    if (k === "id" || /_id$/.test(k) || k === "metadata" || k === "fields") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const value = String(v).trim();
      if (!value) continue;
      out.push(`${k.replace(/_/g, " ")} → ${value.length > 40 ? `${value.slice(0, 37)}…` : value}`);
      if (out.length === 2) break;
    }
  }
  return out.length ? out.join(", ") : null;
}

/** True when the row is one the dashboard should not show at all. */
export function hiddenFromDashboard(e: ActivityWordsEntry): boolean {
  return AUTOMATION_ACTIONS.has(e.action) && automationWords(e).hidden;
}

/** The verb a feed row puts between who and what: one map for every feed
 *  (the dashboard's recent activity and the account's own log each kept a
 *  copy, and they had drifted: only one knew what an automation row says). */
export function activityVerb(a: string): string {
  // Cobblr's action names are snake_case verbs like 'task_created'
  // / 'pairing_created' / 'login'. Turn them into human prose.
  const map: Record<string, string> = {
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
    // One thing added from a scan, its create and follow-up rows folded in
    // (foldOneThingsRows).
    added_from_scan: "scanned in",
    // One-tap stock changes (a button, or a scanned action label).
    part_used: "took one of",
    part_restocked: "restocked",
    // A spreadsheet import is one row for the whole run; its title is the file.
    sheet_imported: "imported",
    sheet_import_undone: "undid the import of",
    sheet_import_partly_undone: "partly undid the import of",
  };
  if (map[a]) return map[a];
  // 'task_created' → 'created task' (the entity_type is already
  // rendered on the row, so we just need the verb).
  if (a.endsWith("_created")) return "created";
  if (a.endsWith("_updated")) return "updated";
  if (a.endsWith("_deleted")) return "deleted";
  return a.replace(/_/g, " ");
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
export function foldOneThingsRows<T extends { action: string; entity_id: string; entity_type: string; diff: unknown; occurred_at: string; user_id: string | null }>(items: T[]): T[] {
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
      out.push(scanned && made ? { ...rep, action: "added_from_scan" } : rep);
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
