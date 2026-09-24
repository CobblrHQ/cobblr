// A notification that asks for a decision keeps its buttons only while the
// thing it asks about is still open. The answer comes from THAT thing's own
// record, read when the inbox is read: never from what a screen remembers
// pressing, and never from a copy written onto the notification.
//
// The bell used to hide a card's buttons after a press in component state
// only, so reopening it showed Approve and Deny on a request already declined
// (#3594); a decision made elsewhere (the permissions page, another approver)
// never reached the card at all. Now every list read passes through
// settleForDisplay: a registered subject that is settled comes back with no
// actions and a line saying how it was settled, on every surface that reads
// the inbox. A kind of notification whose buttons decide something registers
// here; that is the whole cost.

import type { NotificationAction } from "../db/schema.js";

export interface Settled {
  /** "Declined by Sam", "Approved by Sam", "Expired unanswered". */
  label: string;
  /** When it was settled, for the reader's own "2h ago". */
  at: string | null;
}

/** For one org's subjects of one entity type: the settled ones, by id. The
 *  absent ids are still open. Batched, because an inbox page is many rows. */
export type SubjectResolver = (orgId: string, ids: string[]) => Promise<Map<string, Settled>>;

const resolvers = new Map<string, SubjectResolver>();

export function registerNotificationSubject(entityType: string, resolve: SubjectResolver): void {
  resolvers.set(entityType, resolve);
}

interface SettleableRow {
  org_id: string;
  entity_type: string | null;
  entity_id: string | null;
  actions: NotificationAction[] | null;
}

/** The rows as the inbox should show them: a settled subject's buttons gone,
 *  its settlement said. A resolver that fails leaves its rows as they were
 *  (and says so in the log): a stale button is refused by the server anyway,
 *  and the inbox must still open. */
export async function settleForDisplay<T extends SettleableRow>(rows: T[]): Promise<Array<T & { settled: Settled | null }>> {
  const wanted = new Map<string, { orgId: string; entityType: string; ids: Set<string> }>();
  for (const r of rows) {
    if (!r.actions?.length || !r.entity_type || !r.entity_id || !resolvers.has(r.entity_type)) continue;
    const key = `${r.org_id}::${r.entity_type}`;
    const slot = wanted.get(key) ?? { orgId: r.org_id, entityType: r.entity_type, ids: new Set<string>() };
    slot.ids.add(r.entity_id);
    wanted.set(key, slot);
  }
  const settled = new Map<string, Settled>();
  for (const [key, w] of wanted) {
    try {
      const found = await resolvers.get(w.entityType)!(w.orgId, [...w.ids]);
      for (const [id, s] of found) settled.set(`${key}::${id}`, s);
    } catch (err) {
      console.error(`[notification-subjects] ${w.entityType}: could not read settlement:`, (err as Error).message);
    }
  }
  return rows.map((r) => {
    const s = r.entity_type && r.entity_id ? settled.get(`${r.org_id}::${r.entity_type}::${r.entity_id}`) : undefined;
    return s ? { ...r, actions: null, settled: s } : { ...r, settled: null };
  });
}
