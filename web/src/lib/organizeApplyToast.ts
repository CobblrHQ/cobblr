// What the toast says after Accept on a put-away group: the filing's own
// result, never the plan's intent. "Filed 1 item(s)" used to be printed from
// the count of items given a destination, over an item still pending in the
// inbox with an Add button (#2897). Now the api says which records exist and
// which items were only assigned, with why, and the sentence repeats that.
import type { OrganizeApplyResponse } from "./api";

const list = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`);

export function organizeApplyToast(r: OrganizeApplyResponse): { success: string | null; warning: string | null } {
  const created = r.created_locations.map((l) => l.name);
  const filed = (r.filed ?? []).map((f) => f.name).filter(Boolean);
  const held = r.assigned_only ?? [];
  const parts: string[] = [];
  if (created.length) parts.push(`Created ${list(created)}`);
  if (filed.length) parts.push(`filed ${list(filed)}`);
  else if (r.filed_item_ids.length && !r.filed) parts.push(`filed ${r.filed_item_ids.length} item${r.filed_item_ids.length === 1 ? "" : "s"}`);
  const success = parts.length ? parts.join(" and ") + "." : null;
  let warning: string | null = null;
  if (held.length) {
    const reasons = [...new Set(held.map((h) => h.reason))];
    const who = list(held.map((h) => h.name ?? "an item"));
    warning = `${who} ${held.length === 1 ? "has" : "have"} the destination but ${held.length === 1 ? "is" : "are"} not filed yet: ${reasons.join("; ")}.`;
  }
  return { success: success ? success.charAt(0).toUpperCase() + success.slice(1) : null, warning };
}
