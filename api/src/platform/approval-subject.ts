// An approval request, as the subject of the cards its approvers were sent:
// settled the moment it is no longer waiting on anyone (notification-subjects.ts).
// Its own file, with no import of approvals.ts, so the inbox can load it
// without the whole approval machinery (and without an import cycle).

import { meta } from "../db/meta.js";
import { registerNotificationSubject, type Settled } from "./notification-subjects.js";

registerNotificationSubject("approval_request", async (orgId, ids) => {
  const rows = await meta
    .selectFrom("approval_requests as r")
    .leftJoin("users as u", "u.id", "r.decided_by")
    .select(["r.id", "r.status", "r.decided_at", "r.expires_at", "u.display_name as decider"])
    .where("r.org_id", "=", orgId)
    .where("r.id", "in", ids)
    .execute();
  const out = new Map<string, Settled>();
  const now = Date.now();
  for (const r of rows) {
    const by = r.decider ? ` by ${r.decider}` : "";
    const at = r.decided_at ? new Date(r.decided_at).toISOString() : null;
    switch (r.status) {
      case "approved":
      case "resuming":
      case "completed":
        out.set(r.id, { label: `Approved${by}`, at });
        break;
      case "denied":
        out.set(r.id, { label: `Declined${by}`, at });
        break;
      case "withdrawn":
        out.set(r.id, { label: "Withdrawn by the person who asked", at });
        break;
      case "expired":
        out.set(r.id, { label: "Expired unanswered", at: new Date(r.expires_at).toISOString() });
        break;
      default:
        if (new Date(r.expires_at).getTime() <= now) out.set(r.id, { label: "Expired unanswered", at: new Date(r.expires_at).toISOString() });
    }
  }
  return out;
});
