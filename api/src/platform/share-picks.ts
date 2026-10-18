// Sharing things one by one: "Share with…" on a record or a selection, and
// "Stop sharing" (docs/design-decisions/share-spaces.md §9).
//
// Both change a share's scope (ScopeDef in @cobblr/platform-contract/share-scope)
// as little as it takes, so each is the other's exact undo:
//   - share: a record already in the share is left alone; one kept out is let
//     back in; otherwise it is picked.
//   - stop: its pick goes; if a rule (a collection, a field, a lend) still
//     brings it in, it is kept out by name.
// The mirror then runs, so the friend's share space follows at once.

import { sql } from "kysely";
import { readScope, type ScopeDef, type ScopeRef } from "@cobblr/platform-contract/share-scope";
import { meta } from "../db/meta.js";
import { recordsInScope, scopeKey } from "./scope-eval.js";
import { mirrorAndDeliverNow } from "./share-mirror.js";
import { sharePerson } from "./share-person.js";
import { shareRefusal } from "./kind-writer.js";

// One record however it is named: a page's kind or its collection's (#4689).
const key = scopeKey;

export interface ShareTarget {
  link_id: string;
  /** The person, as the share names them. */
  to: string;
}

/** The live shares of this workspace's own things, by person. */
export async function shareTargets(orgId: string): Promise<ShareTarget[]> {
  const rows = await meta.selectFrom("share_links").select(["id", "peer_name", "label"]).where("org_id", "=", orgId).where("side", "=", "owner").where("status", "=", "active").where(sql<boolean>`coalesce(settings->>'purpose', '') <> 'own'`).orderBy("created_at").execute();
  return rows.map((r) => ({ link_id: r.id, to: r.peer_name ?? r.label ?? "them" }));
}

/** A share named the way a person or a model says it: its id, or the
 *  person's name (case aside, or the start of it when only one fits). */
export async function findShareTarget(orgId: string, said: string): Promise<ShareTarget | { error: string }> {
  const targets = await shareTargets(orgId);
  if (!targets.length) return { error: "This workspace is not shared with anyone yet. Share it in Settings, Sharing first." };
  const s = said.trim().toLowerCase();
  const hit =
    targets.find((t) => t.link_id === said.trim()) ??
    targets.find((t) => t.to.toLowerCase() === s) ??
    (targets.filter((t) => t.to.toLowerCase().startsWith(s)).length === 1 ? targets.find((t) => t.to.toLowerCase().startsWith(s)) : undefined);
  if (hit) return hit;
  if (!s && targets.length === 1) return targets[0]!;
  return { error: `Shared with: ${targets.map((t) => t.to).join(", ")}. Say which.` };
}

async function readLinkScope(linkId: string): Promise<{ orgId: string; scope: ScopeDef } | null> {
  const l = await meta.selectFrom("share_links").select(["org_id", "settings"]).where("id", "=", linkId).where("side", "=", "owner").where("status", "=", "active").where(sql<boolean>`coalesce(settings->>'purpose', '') <> 'own'`).executeTakeFirst();
  return l ? { orgId: l.org_id, scope: readScope((l.settings as Record<string, unknown> | null)?.scope) } : null;
}

/** Change a share's scope: the row is locked, the scope read under the lock,
 *  `change` decides from it, and what it returns is written before the lock
 *  is let go (#7143). Two changes at once (stop sharing one record, share
 *  another) each read the other's result, never the same old scope, so the
 *  later write cannot put back what the earlier one took out. Then it is
 *  mirrored and delivered before this answers (share-mirror.ts
 *  mirrorAndDeliverNow), so "stop sharing" means the friend no longer has it
 *  when the owner is told so; mirror_due_at is set with the scope, so a
 *  mirror that fails here is still owed. */
export async function changeLinkScope<T>(
  linkId: string,
  change: (orgId: string, scope: ScopeDef) => Promise<{ scope: ScopeDef | null; answer: T }>,
): Promise<{ answer: T; delivered?: boolean } | null> {
  const done = await meta.transaction().execute(async (trx) => {
    const l = await trx.selectFrom("share_links").select(["org_id", "settings"]).where("id", "=", linkId).where("side", "=", "owner").where("status", "=", "active").where(sql<boolean>`coalesce(settings->>'purpose', '') <> 'own'`).forUpdate().executeTakeFirst();
    if (!l) return null;
    const { scope, answer } = await change(l.org_id, readScope((l.settings as Record<string, unknown> | null)?.scope));
    if (scope) {
      await trx
        .updateTable("share_links")
        .set({ settings: sql`coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ scope })}::jsonb` as never, mirror_due_at: new Date() })
        .where("id", "=", linkId)
        .execute();
    }
    return { answer, wrote: !!scope };
  });
  if (!done) return null;
  if (!done.wrote) return { answer: done.answer };
  const r = await mirrorAndDeliverNow(linkId).catch((err) => {
    console.error(`[share] mirror of ${linkId} failed:`, err);
    return { delivered: false };
  });
  return { answer: done.answer, delivered: r.delivered };
}

async function inScope(orgId: string, linkId: string, scope: ScopeDef): Promise<Set<string>> {
  const person = await sharePerson(linkId).catch(() => null);
  return new Set((await recordsInScope(orgId, scope, { person: person?.id ?? null })).refs.map(key));
}

/** Put these records in a share. Answers the ones it changed (the rest were
 *  in already). */
export async function shareRecords(linkId: string, refs: ScopeRef[]): Promise<{ changed: ScopeRef[]; delivered?: boolean } | { error: string }> {
  const r = await changeLinkScope<{ changed: ScopeRef[] } | { error: string }>(linkId, async (orgId, current) => {
    const refused = await shareRefusal(orgId, refs.map((x) => x.entity_kind));
    if (refused) return { scope: null, answer: { error: refused } };
    const scope = { ...current, picks: [...current.picks], excluded: [...current.excluded] };
    const before = await inScope(orgId, linkId, scope);
    const changed: ScopeRef[] = [];
    const wanted = refs.filter((x) => !before.has(key(x)));
    if (!wanted.length) return { scope: null, answer: { changed } };
    const want = new Set(wanted.map(key));
    scope.excluded = scope.excluded.filter((x) => !want.has(key(x)));
    const now = await inScope(orgId, linkId, scope);
    for (const x of wanted) {
      if (!now.has(key(x)) && !scope.picks.some((p) => key(p) === key(x))) scope.picks.push({ entity_kind: x.entity_kind, id: x.id });
      changed.push(x);
    }
    return { scope, answer: { changed } };
  });
  if (!r) return { error: "That share has ended." };
  return "error" in r.answer ? r.answer : { changed: r.answer.changed, ...(r.delivered !== undefined ? { delivered: r.delivered } : {}) };
}

/** Take these records out of a share. Answers the ones it changed (the rest
 *  were not in it). */
export async function stopSharingRecords(linkId: string, refs: ScopeRef[]): Promise<{ changed: ScopeRef[]; delivered?: boolean } | { error: string }> {
  const r = await changeLinkScope<ScopeRef[]>(linkId, async (orgId, current) => {
    const scope = { ...current, picks: [...current.picks], excluded: [...current.excluded] };
    const before = await inScope(orgId, linkId, scope);
    const wanted = refs.filter((x) => before.has(key(x)));
    if (!wanted.length) return { scope: null, answer: [] };
    const want = new Set(wanted.map(key));
    scope.picks = scope.picks.filter((p) => !want.has(key(p)));
    const now = await inScope(orgId, linkId, scope);
    for (const x of wanted) if (now.has(key(x))) scope.excluded.push({ entity_kind: x.entity_kind, id: x.id });
    return { scope, answer: wanted };
  });
  if (!r) return { error: "That share has ended." };
  return { changed: r.answer, ...(r.delivered !== undefined ? { delivered: r.delivered } : {}) };
}

/** The shares a record is in now, for its page ("Shared with Vince"). */
export async function sharesOfRecord(orgId: string, kind: string, id: string): Promise<ShareTarget[]> {
  const out: ShareTarget[] = [];
  for (const t of await shareTargets(orgId)) {
    const got = await readLinkScope(t.link_id);
    if (got && (await inScope(orgId, t.link_id, got.scope)).has(key({ entity_kind: kind, id }))) out.push(t);
  }
  return out;
}

export async function sharesOfCollection(orgId: string, kind: string): Promise<ShareTarget[]> {
  const out: ShareTarget[] = [];
  for (const t of await shareTargets(orgId)) {
    const got = await readLinkScope(t.link_id);
    if (got?.scope.rules.some((r) => r.type === "collection" && r.entity_kind === kind)) out.push(t);
  }
  return out;
}

export async function shareCollection(linkId: string, kind: string, stop: boolean): Promise<{ changed: boolean; delivered?: boolean } | { error: string }> {
  const r = await changeLinkScope<{ changed: boolean } | { error: string }>(linkId, async (orgId, current) => {
    const has = current.rules.some((x) => x.type === "collection" && x.entity_kind === kind);
    if (has === !stop) return { scope: null, answer: { changed: false } };
    if (!stop) {
      const refused = await shareRefusal(orgId, [kind]);
      if (refused) return { scope: null, answer: { error: refused } };
    }
    const scope = { ...current, rules: current.rules.filter((x) => !(x.type === "collection" && x.entity_kind === kind)) };
    if (!stop) scope.rules.push({ type: "collection", entity_kind: kind });
    return { scope, answer: { changed: true } };
  });
  if (!r) return { error: "That share has ended." };
  return "error" in r.answer ? r.answer : { changed: r.answer.changed, ...(r.delivered !== undefined ? { delivered: r.delivered } : {}) };
}
