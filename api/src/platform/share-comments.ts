// One conversation across a share (#4627 §2, docs/design-decisions/share-spaces.md §12).
//
// A comment on a shared record goes to the other side: the friend's comment
// on a copy appears in the original's Discussion in the owner's workspace,
// and the owner's on the original appears on the copy. The kernel never
// imports the discussion module: it hears "core-discussion.comment.posted",
// sends the comment over the link, and on the other side announces
// "platform.share.comment-arrived", which the discussion module turns into a
// guest's comment there. A comment that itself arrived that way is a guest's
// and is never sent back, so nothing echoes.

import { platform } from "@cobblr/platform-contract";
import { SHARE_COMMENT_ARRIVED } from "@cobblr/platform-contract/share-offer";
import { meta } from "../db/meta.js";
import { lookup } from "./entities.js";
import { ORIGIN_REF_KEY, copyOf, originRef } from "./share-mirror.js";
import { enqueueShareOp, registerShareOp } from "./share-sync.js";


interface Posted {
  orgId?: unknown;
  comment_id?: unknown;
  source_module?: unknown;
  source_type?: unknown;
  source_id?: unknown;
  author_kind?: unknown;
  author_name?: unknown;
  body?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Where a comment on this record should go, if anywhere: the owner of the
 *  original (from a copy), or each share holding the original. */
async function destinations(orgId: string, kind: string, id: string): Promise<Array<{ linkId: string; origin: { kind: string; id: string } }>> {
  const out: Array<{ linkId: string; origin: { kind: string; id: string } }> = [];
  const shareSide = await meta.selectFrom("share_links").select("id").where("org_id", "=", orgId).where("side", "=", "share").where("status", "=", "active").execute();
  if (shareSide.length) {
    const rec = await lookup(orgId, kind, id).catch(() => null);
    const m = ((rec?.fields as Record<string, unknown> | undefined)?.metadata ?? {}) as Record<string, unknown>;
    const ref = str(m[ORIGIN_REF_KEY]).split("/");
    if (ref.length === 3 && shareSide.some((l) => l.id === ref[0])) out.push({ linkId: ref[0]!, origin: { kind: ref[1]!, id: ref[2]! } });
    return out;
  }
  const held = await meta
    .selectFrom("share_mirror_state as m")
    .innerJoin("share_links as l", "l.id", "m.link_id")
    .select(["m.link_id", "m.entity_kind"])
    .where("l.org_id", "=", orgId)
    .where("l.side", "=", "owner")
    .where("l.status", "=", "active")
    .where("m.entity_id", "=", id)
    .execute();
  for (const h of held) out.push({ linkId: h.link_id, origin: { kind: h.entity_kind, id } });
  return out;
}

export function registerShareComments(): void {
  platform().events.on("core-discussion.comment.posted", "platform", async (payload) => {
    const p = (payload ?? {}) as Posted;
    // A guest's comment arrived from the other side; sending it back would echo.
    if (str(p.author_kind) !== "user") return;
    const orgId = str(p.orgId);
    const id = str(p.source_id);
    const body = str(p.body);
    if (!orgId || !id || !body.trim()) return;
    const kind = `${str(p.source_module)}:${str(p.source_type)}`;
    for (const d of await destinations(orgId, kind, id).catch(() => [])) {
      await enqueueShareOp(d.linkId, "comment.posted", { origin: d.origin, body, author_name: str(p.author_name), ref: `${d.linkId}:${str(p.comment_id)}` });
    }
  });

  registerShareOp("comment.posted", async (link, p) => {
    const origin = p.origin as { kind?: string; id?: string } | undefined;
    if (!origin?.kind || !origin.id) return;
    let target: { kind: string; id: string } | null = null;
    if (link.side === "owner") target = { kind: origin.kind, id: origin.id };
    else {
      const copy = await copyOf(link.org_id, origin.kind, originRef(link, origin.kind, origin.id));
      if (copy) target = { kind: origin.kind, id: copy };
    }
    if (!target) return;
    await platform().events.emit(SHARE_COMMENT_ARRIVED, {
      orgId: link.org_id,
      kind: target.kind,
      id: target.id,
      body: str(p.body),
      author_name: str(p.author_name) || link.peer_name || "Someone you share with",
      external_ref: str(p.ref),
    });
  });
}
