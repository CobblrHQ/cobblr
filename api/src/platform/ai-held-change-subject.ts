import { HELD_CHANGE_TTL_MS } from "./ai-held-change-policy.js";
import { meta } from "../db/meta.js";
import { registerNotificationSubject, type Settled } from "./notification-subjects.js";

registerNotificationSubject("ai_held_change", async (orgId, ids) => {
  const rows = await meta
    .selectFrom("ai_held_changes")
    .select(["id", "status", "outcome", "decided_at", "created_at"])
    .where("org_id", "=", orgId)
    .where("id", "in", ids)
    .execute();
  const settled = new Map<string, Settled>();
  for (const row of rows) {
    const expiresAt = new Date(row.created_at).getTime() + HELD_CHANGE_TTL_MS;
    const expiredUnanswered = row.status === "waiting" && Date.now() > expiresAt;
    if (row.status === "waiting" && !expiredUnanswered) continue;
    const at = row.decided_at ? new Date(row.decided_at).toISOString() : expiredUnanswered ? new Date(expiresAt).toISOString() : null;
    let label: string;
    switch (row.status) {
      case "kept": label = "Kept. Nothing was deleted."; break;
      case "waiting":
      case "expired": label = "Expired unanswered. Nothing was deleted."; break;
      case "failed": label = row.outcome || "The delete did not go through."; break;
      default: label = row.outcome || "Deletion is being processed.";
    }
    settled.set(row.id, { label, at });
  }
  return settled;
});
