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

/** For the answers one module's actions give: each press argument set, and
 *  whether what it asks about has already been answered. Null is still open.
 *  Read from the module's own record when the inbox is read, never from what a
 *  screen remembers pressing (#7851). */
export type ActionSettler = (orgId: string, args: Array<Record<string, unknown>>) => Promise<Array<Settled | null>>;

const actionSettlers = new Map<string, ActionSettler>();

/** A notification whose buttons answer a question about a record registers
 *  here, by the action ids its buttons run. A button whose question the record
 *  says is answered comes back without it, and its row says how. */
export function registerActionSettlement(actionIds: readonly string[], settle: ActionSettler): void {
  for (const id of actionIds) actionSettlers.set(id, settle);
}

interface SettleableRow {
  org_id: string;
  entity_type: string | null;
  entity_id: string | null;
  actions: NotificationAction[] | null;
  card?: { rows?: Array<{ text: string; actions?: string[]; settled?: Settled }> } | null;
}

/** Drop the buttons whose question is answered; a card row whose buttons all went says how. */
async function settleActions<T extends SettleableRow>(row: T): Promise<T & { settled?: Settled | null }> {
  const answered = new Map<string, Settled>();
  const bySettler = new Map<ActionSettler, NotificationAction[]>();
  for (const a of row.actions ?? []) {
    const settler = actionSettlers.get(a.action);
    if (settler) bySettler.set(settler, [...(bySettler.get(settler) ?? []), a]);
  }
  for (const [settler, actions] of bySettler) {
    try {
      const found = await settler(row.org_id, actions.map((a) => a.args ?? {}));
      actions.forEach((a, i) => { const s = found[i]; if (s) answered.set(a.id, s); });
    } catch (err) {
      console.error(`[notification-subjects] ${actions[0]!.action}: could not read the answer:`, (err as Error).message);
    }
  }
  if (answered.size === 0) return row;
  const open = (row.actions ?? []).filter((a) => !answered.has(a.id));
  const rows = row.card?.rows?.map((r) => {
    const mine = (r.actions ?? []).filter((id) => answered.has(id));
    if (mine.length === 0 || mine.length < (r.actions ?? []).length) return { ...r, actions: (r.actions ?? []).filter((id) => !answered.has(id)) };
    return { ...r, actions: [], settled: answered.get(mine[0]!)! };
  });
  const out = { ...row, actions: open.length ? open : null, ...(row.card ? { card: { ...row.card, ...(rows ? { rows } : {}) } } : {}) };
  // A flat notification (no rows) whose every button is answered is settled as a whole.
  return !row.card?.rows?.length && open.length === 0 ? { ...out, settled: [...answered.values()][0]! } : out;
}

/** The rows as the inbox should show them: a settled subject's buttons gone,
 *  its settlement said. A resolver that fails leaves its rows as they were
 *  (and says so in the log): a stale button is refused by the server anyway,
 *  and the inbox must still open. */
export async function settleForDisplay<T extends SettleableRow>(input: T[]): Promise<Array<T & { settled: Settled | null }>> {
  const rows = await Promise.all(input.map(settleActions));
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
    return s ? { ...r, actions: null, settled: s } : { ...r, settled: (r as { settled?: Settled | null }).settled ?? null };
  });
}
