// What the friend adds to a share (#4627 §2.8, docs/design-decisions/share-spaces.md §11).
//
// A record the friend makes in the share space (a part, a printer they found)
// is not a copy of anything of the owner's. The share's side sends it once as
// `copy.added`; the owner sees "Vince added X to the share" and takes it into
// their own collection or leaves it. Taken, it becomes the owner's record,
// stays in the share, and the friend's record becomes its copy (it is told
// `added.taken` and carries the new origin), so nothing is doubled.

import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { lookup } from "./entities.js";
import { COPY_BOOKKEEPING, ORIGIN_REF_KEY, isReference } from "./share-mirror.js";
import { noteShare } from "./share-notices.js";
import { shareRecords } from "./share-picks.js";
import { enqueueShareOp, getShareLink, registerShareOp, type ShareLinkRow } from "./share-sync.js";
import { runExclusive } from "./exclusive.js";

const plain = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !COPY_BOOKKEEPING.has(k) && !k.startsWith("_") && !k.endsWith("_label") && !isReference(k) && v !== null && v !== undefined && typeof v !== "object"));

/** The share's side: send each record the friend made here, once. Called
 *  from the edits pass, with the kinds the share holds copies of. */
export async function sendAdditions(link: ShareLinkRow, kinds: string[]): Promise<number> {
  let sent = 0;
  for (const kind of kinds) {
    const all = await platform().entities.listAll(link.org_id, kind, {}, undefined, { cap: 500 }).catch(() => ({ items: [] as Array<{ id: string }> }));
    const seen = new Set((await meta.selectFrom("share_added").select("copy_id").where("link_id", "=", link.id).execute()).map((r) => r.copy_id));
    for (const it of all.items) {
      if (seen.has(it.id)) continue;
      const rec = await lookup(link.org_id, kind, it.id).catch(() => null);
      if (!rec) continue;
      const f = (rec.fields ?? {}) as Record<string, unknown>;
      const m = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
      if (typeof m[ORIGIN_REF_KEY] === "string") continue;
      await meta.insertInto("share_added").values({ link_id: link.id, copy_kind: kind, copy_id: it.id }).onConflict((oc) => oc.doNothing()).execute();
      await enqueueShareOp(link.id, "copy.added", { copy_id: it.id, kind, title: rec.title, fields: plain(f), metadata: plain(m) });
      sent++;
    }
  }
  return sent;
}

export interface ShareAdditionRow {
  id: string;
  link_id: string;
  entity_kind: string;
  title: string;
  by_name: string | null;
  status: "pending" | "taken" | "left";
  created_at: Date;
}

/** What the friend added, waiting for the owner (or all of it). */
export async function listAdditions(orgId: string, open = true): Promise<ShareAdditionRow[]> {
  return meta
    .selectFrom("share_additions")
    .select(["id", "link_id", "entity_kind", "title", "by_name", "status", "created_at"])
    .where("org_id", "=", orgId)
    .$if(open, (q) => q.where("status", "=", "pending"))
    .orderBy("created_at", "desc")
    .limit(200)
    .execute();
}

/** On the owner's record a Take made, which addition it was made from: so a
 *  Take that died after making it, and is pressed again, finds that record
 *  instead of making a second (#7131). Underscored, so it never travels. */
export const TAKEN_FROM_KEY = "_share_addition";

/** Decide one addition at a time, whichever tab, process or door asks: two
 *  Takes read "pending" together and each made a record (#7131). */
async function deciding<T>(additionId: string, decide: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  let out: T | undefined;
  const run = await runExclusive(`share.addition.${additionId}`, async () => {
    out = await decide();
  });
  return run.ran ? out! : { ok: false, error: "Someone is deciding that right now." };
}

/** The record an earlier Take of this addition made, if one did. */
async function madeFrom(orgId: string, kind: string, additionId: string): Promise<string | null> {
  const w = await platform().entities.getWriter(orgId, kind);
  if (w?.findByKey) return w.findByKey(orgId, { field: TAKEN_FROM_KEY, metadata: true }, additionId);
  const all = await platform().entities.listAll(orgId, kind, { filter: { [TAKEN_FROM_KEY]: additionId }, include_retired: true }, undefined, { cap: 2 });
  return all.items[0]?.id ?? null;
}

/** Take what the friend added into the owner's own collection. */
export async function takeAddition(orgId: string, additionId: string): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> {
  return deciding(additionId, async () => {
    const a = await meta.selectFrom("share_additions").selectAll().where("id", "=", additionId).where("org_id", "=", orgId).executeTakeFirst();
    if (!a) return { ok: false as const, error: "That is not here any more." };
    if (a.status !== "pending") return { ok: false as const, error: "That was already taken or left." };
    const w = await platform().entities.getWriter(orgId, a.entity_kind);
    if (!w) return { ok: false as const, error: "This workspace has nowhere to keep that kind of thing." };
    const id =
      (await madeFrom(orgId, a.entity_kind, a.id)) ??
      // NOT-A-COPY: the owner's own new record, made from what the friend added; the friend's becomes its copy
      (await w.create(orgId, { ...(a.fields as Record<string, unknown>), name: a.title, metadata: { ...(a.metadata as Record<string, unknown>), [TAKEN_FROM_KEY]: a.id } }));
    const claimed = await meta
      .updateTable("share_additions")
      .set({ status: "taken", taken_id: id, decided_at: new Date() })
      .where("id", "=", a.id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return { ok: false as const, error: "That was already taken or left." };
    // Their record becomes the copy before the mirror sends one, so it is one
    // thing, not two. Keyed by the addition, so it is told once.
    await enqueueShareOp(a.link_id, "added.taken", { copy_id: a.peer_copy_id, origin: { kind: a.entity_kind, id } }, `added.taken.${a.id}`);
    const shared = await shareRecords(a.link_id, [{ entity_kind: a.entity_kind, id }]);
    if ("error" in shared) console.error(`[share] taken ${id} not shared back:`, shared.error);
    return { ok: true as const, id, title: a.title };
  });
}

/** Leave what the friend added in their share space, and not take it. */
export async function leaveAddition(orgId: string, additionId: string): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  return deciding(additionId, async () => {
    const a = await meta.selectFrom("share_additions").select(["id", "status", "title"]).where("id", "=", additionId).where("org_id", "=", orgId).executeTakeFirst();
    if (!a) return { ok: false as const, error: "That is not here any more." };
    if (a.status !== "pending") return { ok: false as const, error: "That was already taken or left." };
    const left = await meta.updateTable("share_additions").set({ status: "left", decided_at: new Date() }).where("id", "=", a.id).where("status", "=", "pending").executeTakeFirst();
    if (Number(left.numUpdatedRows) === 0) return { ok: false as const, error: "That was already taken or left." };
    return { ok: true as const, title: a.title };
  });
}

export function registerShareAdditionOps(): void {
  // The owner's side: something the friend added.
  registerShareOp("copy.added", async (link, p) => {
    if (link.side !== "owner") return;
    const copyId = String(p.copy_id ?? "");
    const kind = String(p.kind ?? "");
    const title = String(p.title ?? "").slice(0, 300) || "Something";
    if (!copyId || !kind) throw new Error("an addition without its record");
    const made = await meta
      .insertInto("share_additions")
      .values({
        org_id: link.org_id,
        link_id: link.id,
        peer_copy_id: copyId,
        entity_kind: kind,
        title,
        fields: JSON.stringify(p.fields ?? {}) as never,
        metadata: JSON.stringify(p.metadata ?? {}) as never,
        by_name: link.peer_name,
      })
      .onConflict((oc) => oc.columns(["link_id", "peer_copy_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (made) await noteShare(link.id, "added", title);
  });

  // The share's side: the owner took it; the friend's record is its copy now.
  registerShareOp("added.taken", async (link, p) => {
    const copyId = String(p.copy_id ?? "");
    const origin = p.origin as { kind?: string; id?: string } | undefined;
    if (!copyId || !origin?.kind || !origin.id) return;
    const self = await getShareLink(link.id);
    if (!self) return;
    await platform().entities.mergeMetadata(link.org_id, origin.kind, copyId, { [ORIGIN_REF_KEY]: `${link.id}/${origin.kind}/${origin.id}` });
  });
}
