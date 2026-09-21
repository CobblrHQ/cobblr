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
  actor: { display_name: string | null } | null;
}

export const AUTOMATION_ACTIONS: ReadonlySet<string> = new Set(["wire_fired", "wire_failed"]);

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Who to credit a row to: the real user, else "Automation" for a wire. */
export function actorWords(e: ActivityWordsEntry): string {
  return e.actor?.display_name ?? (AUTOMATION_ACTIONS.has(e.action) ? "Automation" : "someone");
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
