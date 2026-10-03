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
import { mirrorShareNow } from "./share-mirror.js";
import { sharePerson } from "./share-person.js";

// One record however it is named: a page's kind or its collection's (#4689).
const key = scopeKey;

export interface ShareTarget {
  link_id: string;
  /** The person, as the share names them. */
  to: string;
}

/** The live shares of this workspace's own things, by person. */
export async function shareTargets(orgId: string): Promise<ShareTarget[]> {
  const rows = await meta.selectFrom("share_links").select(["id", "peer_name", "label"]).where("org_id", "=", orgId).where("side", "=", "owner").where("status", "=", "active").orderBy("created_at").execute();
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
  const l = await meta.selectFrom("share_links").select(["org_id", "settings"]).where("id", "=", linkId).where("side", "=", "owner").where("status", "=", "active").executeTakeFirst();
  return l ? { orgId: l.org_id, scope: readScope((l.settings as Record<string, unknown> | null)?.scope) } : null;
}

async function writeLinkScope(linkId: string, scope: ScopeDef): Promise<void> {
  await meta
    .updateTable("share_links")
    .set({ settings: sql`coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ scope })}::jsonb` as never, mirror_due_at: new Date() })
    .where("id", "=", linkId)
    .execute();
  void mirrorShareNow(linkId).catch((err) => console.error(`[share] mirror of ${linkId} failed:`, err));
}

async function inScope(orgId: string, linkId: string, scope: ScopeDef): Promise<Set<string>> {
  const person = await sharePerson(linkId).catch(() => null);
  return new Set((await recordsInScope(orgId, scope, { person: person?.id ?? null })).refs.map(key));
}

/** Put these records in a share. Answers the ones it changed (the rest were
 *  in already). */
export async function shareRecords(linkId: string, refs: ScopeRef[]): Promise<{ changed: ScopeRef[] } | { error: string }> {
  const got = await readLinkScope(linkId);
  if (!got) return { error: "That share has ended." };
  const scope = { ...got.scope, picks: [...got.scope.picks], excluded: [...got.scope.excluded] };
  const before = await inScope(got.orgId, linkId, scope);
  const changed: ScopeRef[] = [];
  const wanted = refs.filter((r) => !before.has(key(r)));
  if (!wanted.length) return { changed };
  const want = new Set(wanted.map(key));
  scope.excluded = scope.excluded.filter((x) => !want.has(key(x)));
  const now = await inScope(got.orgId, linkId, scope);
  for (const r of wanted) {
    if (!now.has(key(r)) && !scope.picks.some((p) => key(p) === key(r))) scope.picks.push({ entity_kind: r.entity_kind, id: r.id });
    changed.push(r);
  }
  await writeLinkScope(linkId, scope);
  return { changed };
}

/** Take these records out of a share. Answers the ones it changed (the rest
 *  were not in it). */
export async function stopSharingRecords(linkId: string, refs: ScopeRef[]): Promise<{ changed: ScopeRef[] } | { error: string }> {
  const got = await readLinkScope(linkId);
  if (!got) return { error: "That share has ended." };
  const scope = { ...got.scope, picks: [...got.scope.picks], excluded: [...got.scope.excluded] };
  const before = await inScope(got.orgId, linkId, scope);
  const wanted = refs.filter((r) => before.has(key(r)));
  if (!wanted.length) return { changed: [] };
  const want = new Set(wanted.map(key));
  scope.picks = scope.picks.filter((p) => !want.has(key(p)));
  const now = await inScope(got.orgId, linkId, scope);
  for (const r of wanted) if (now.has(key(r))) scope.excluded.push({ entity_kind: r.entity_kind, id: r.id });
  await writeLinkScope(linkId, scope);
  return { changed: wanted };
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
