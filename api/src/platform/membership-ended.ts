// A person's membership of a workspace ended: every stream they hold open on
// it closes (#4115, trust class 2). A stream is let in once, when it opens; a
// removed member's tab kept hearing which records changed after they were
// removed, because nothing asked again.
//
// In-process, like the record stream it closes: the api that serves a tab is
// the one its removal is made on. A path that ends a membership without
// announcing it is caught by the stream's own check before it sends
// (openWorkspaceSse), a few seconds later at most.
import { meta } from "../db/meta.js";

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const keyOf = (orgId: string, userId: string) => `${orgId}:${userId}`;

export function onMembershipEnded(orgId: string, userId: string, fn: Listener): () => void {
  const key = keyOf(orgId, userId);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(key);
  };
}

export function announceMembershipEnded(orgId: string, userId: string): void {
  for (const fn of [...(listeners.get(keyOf(orgId, userId)) ?? [])]) {
    try {
      fn();
    } catch {
      // One stream that would not close must not keep the others open.
    }
  }
}

/** This person's role in this workspace now, or null when they are not in it. */
export async function roleNow(orgId: string, userId: string): Promise<string | null> {
  const row = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", userId).executeTakeFirst();
  return row ? String(row.role) : null;
}

/** A person's role in a workspace changed: every stream they hold on it asks
 *  again what it may still carry, and closes when that is nothing (a member
 *  made a guest sees the portal, never which records changed). */
export function announceRoleChanged(orgId: string, userId: string): void {
  announceMembershipEnded(orgId, userId);
}
