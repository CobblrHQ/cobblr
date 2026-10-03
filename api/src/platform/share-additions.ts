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

/** Take what the friend added into the owner's own collection. */
export async function takeAddition(orgId: string, additionId: string): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> {
  const a = await meta.selectFrom("share_additions").selectAll().where("id", "=", additionId).where("org_id", "=", orgId).executeTakeFirst();
  if (!a) return { ok: false, error: "That is not here any more." };
  if (a.status !== "pending") return { ok: false, error: "That was already taken or left." };
  const w = await platform().entities.getWriter(orgId, a.entity_kind);
  if (!w) return { ok: false, error: "This workspace has nowhere to keep that kind of thing." };
  // NOT-A-COPY: the owner's own new record, made from what the friend added; the friend's becomes its copy
  const id = await w.create(orgId, { ...(a.fields as Record<string, unknown>), name: a.title, metadata: a.metadata });
  await meta.updateTable("share_additions").set({ status: "taken", taken_id: id, decided_at: new Date() }).where("id", "=", a.id).execute();
  // Their record becomes the copy before the mirror sends one, so it is one thing, not two.
  await enqueueShareOp(a.link_id, "added.taken", { copy_id: a.peer_copy_id, origin: { kind: a.entity_kind, id } });
  const shared = await shareRecords(a.link_id, [{ entity_kind: a.entity_kind, id }]);
  if ("error" in shared) console.error(`[share] taken ${id} not shared back:`, shared.error);
  return { ok: true, id, title: a.title };
}

/** Leave what the friend added in their share space, and not take it. */
export async function leaveAddition(orgId: string, additionId: string): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const a = await meta.selectFrom("share_additions").select(["id", "status", "title"]).where("id", "=", additionId).where("org_id", "=", orgId).executeTakeFirst();
  if (!a) return { ok: false, error: "That is not here any more." };
  if (a.status !== "pending") return { ok: false, error: "That was already taken or left." };
  await meta.updateTable("share_additions").set({ status: "left", decided_at: new Date() }).where("id", "=", a.id).execute();
  return { ok: true, title: a.title };
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
