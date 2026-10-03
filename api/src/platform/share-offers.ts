// Handing things over across a share (docs/design-decisions/share-spaces.md
// §6, #4627 §3).
//
// The giver offers records (or, from a share space, scan inbox rows). Each
// becomes an offer row here ('out') and a change to the other side, which
// lands the thing in its scan inbox as an offer ('in') through the inbox's
// OfferIntake. The receiver takes it (it stays, or in a share space moves to
// a workspace of theirs), passes, or leaves it for later; the giver hears the
// answer. Taken, the giver's record is "Given away to <them>"
// (platform:mark-gone's lifecycle); sent back within SEND_BACK_DAYS, both
// sides return to how they were. The giver can withdraw an open offer.
//
// Every change between the sides names the giver's offer id; each side keeps
// its own row and decides for itself what a change may do to its things.

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import {
  RECORD_OFFER_KEY,
  SEND_BACK_DAYS,
  type OfferDecision,
  type OfferIntake,
  type OfferState,
  type OfferedThing,
} from "@cobblr/platform-contract/share-offer";
import { ORG_ROLES, roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { bringBack, markGone } from "./dispositions.js";
import { lookup, resolveKind } from "./entities.js";
import { resolveFieldDefsForKind } from "./field-defs.js";
import { PROVENANCE_FIELDS } from "@cobblr/platform-contract/provenance-fields";
import { fileIdFromRawPath } from "./file-paths.js";
import { enqueueShareOp, getShareLink, registerShareOp, type ShareLinkRow } from "./share-sync.js";

type RecordSource = { org_id: string; kind: string; id: string };
type InboxSource = { org_id: string; inbox_id: string };
type Source = RecordSource | InboxSource;
type Landed = { org_id: string; inbox_id: string };
const isRecord = (s: Source): s is RecordSource => "kind" in s;

function intake(): OfferIntake {
  const i = platform().scan.offerIntake();
  // A change is never dropped: without an inbox to land in, it fails and is
  // tried again once one is there.
  if (!i) throw new Error("this workspace has no scan inbox to receive offers into");
  return i;
}

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

async function photosOf(orgId: string, kind: string, id: string, imagePath: unknown): Promise<OfferedThing["photos"]> {
  const fileIds: string[] = [];
  const own = fileIdFromRawPath(imagePath);
  if (own) fileIds.push(own);
  const [module, type] = kind.split(":");
  const att = await platform()
    .files.listAttachments(orgId, { source_module: module ?? kind, source_type: type ?? kind, source_id: id })
    .catch(() => null);
  for (const a of att ?? []) if (a.kind === "image" && !fileIds.includes(a.fileId)) fileIds.push(a.fileId);
  const out: OfferedThing["photos"] = [];
  for (const f of fileIds.slice(0, MAX_PHOTOS)) {
    const got = (await platform().files.read(orgId, f, "medium").catch(() => null)) ?? (await platform().files.read(orgId, f, "original").catch(() => null));
    if (got && got.bytes.byteLength <= MAX_PHOTO_BYTES) out.push({ mime: got.mimeType, data: Buffer.from(got.bytes).toString("base64") });
  }
  return out;
}

/** A record as a thing to hand over: its name, its make, its fields by their
 *  labels, its photos. */
/** The collection a record is kept in: its module and, for a collection of
 *  its own, the instance, whichever kind its page named it by (#4682). */
async function collectionOf(orgId: string, kind: string, f: Record<string, unknown>): Promise<{ module: string; instance: string | null }> {
  const r = await resolveKind(orgId, kind).catch(() => ({ base: kind, instance: null as string | null }));
  const module = r.base.split(":")[0]!;
  const own = typeof f.instance === "string" && f.instance && f.instance !== module ? f.instance : null;
  return { module, instance: r.instance ?? own };
}

export async function recordAsThing(orgId: string, kind: string, id: string): Promise<OfferedThing | null> {
  const ent = await lookup(orgId, kind, id);
  if (!ent) return null;
  const f = (ent.fields ?? {}) as Record<string, unknown>;
  const metaBag = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
  const defs = await platform().entities.fieldsFor(orgId, kind).catch(() => []);
  const fields: Record<string, string> = {};
  for (const d of defs) {
    const v = d.native ? f[d.name] : metaBag[d.name];
    if (v === null || v === undefined || v === "" || typeof v === "object") continue;
    fields[d.display_label || d.name] = String(v);
  }
  const kindRec = await platform().entities.getKind(kind).catch(() => null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    name: ent.title,
    manufacturer: str(f.manufacturer),
    model: str(f.model),
    kind_words: kindRec?.display_name ?? null,
    collection: await collectionOf(orgId, kind, f),
    quantity: typeof f.quantity === "number" ? f.quantity : null,
    notes: str(f.notes) ?? str(f.description),
    fields,
    photos: await photosOf(orgId, kind, id, f.image_path),
  };
}

export interface OfferTarget {
  link_id: string;
  /** Who it goes to ("Sam", the person a share links to). */
  to: string;
}

/** The shares this person can hand things over through from this workspace:
 *  the ones this workspace is shared over, and, when they are in share spaces
 *  on this Cobblr, the sharers of those. */
export async function offerTargets(orgId: string, userId: string): Promise<OfferTarget[]> {
  const rows = await meta
    .selectFrom("share_links as l")
    .select(["l.id", "l.peer_name", "l.label", "l.org_id"])
    .where("l.status", "=", "active")
    .where((eb) =>
      eb.or([
        eb("l.org_id", "=", orgId),
        eb.and([
          eb("l.side", "=", "share"),
          eb("l.org_id", "in", eb.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId)),
        ]),
      ]),
    )
    .orderBy("l.created_at")
    .execute();
  return rows.map((r) => ({ link_id: r.id, to: r.peer_name ?? r.label ?? "them" }));
}

async function mayOfferOver(orgId: string, userId: string, linkId: string): Promise<ShareLinkRow | null> {
  const ok = (await offerTargets(orgId, userId)).some((t) => t.link_id === linkId);
  const link = ok ? await getShareLink(linkId) : null;
  return link?.status === "active" ? link : null;
}

async function sendOffers(link: ShareLinkRow, userId: string | null, items: Array<{ source: Source; thing: OfferedThing }>): Promise<string[]> {
  const batch = randomUUID();
  const fromName = await nameOf(userId);
  const ids: string[] = [];
  for (const it of items) {
    const row = await meta
      .insertInto("share_offers")
      .values({ link_id: link.id, direction: "out", batch, title: it.thing.name, source: JSON.stringify(it.source) as never, created_by: userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.push(row.id);
    await enqueueShareOp(link.id, "offer.create", { offer_id: row.id, batch, from_name: fromName, thing: it.thing as unknown as Record<string, unknown> }, `offer.create:${row.id}`);
  }
  return ids;
}

async function nameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await meta.selectFrom("users").select(["display_name", "email"]).where("id", "=", userId).executeTakeFirst();
  return u?.display_name || u?.email?.split("@")[0] || null;
}

/** Offer records of this workspace to the person a share links to. Each is
 *  marked "offered to <them>" until they answer. */
export async function offerRecords(
  orgId: string,
  userId: string,
  linkId: string,
  kind: string,
  ids: readonly string[],
): Promise<{ ok: true; offered: number; to: string } | { ok: false; error: string }> {
  const link = await mayOfferOver(orgId, userId, linkId);
  if (!link) return { ok: false, error: "That share is not one you can hand things over through from here." };
  const items: Array<{ source: Source; thing: OfferedThing }> = [];
  for (const id of ids) {
    const thing = await recordAsThing(orgId, kind, id);
    if (!thing) return { ok: false, error: `no ${kind} record with id ${id}` };
    items.push({ source: { org_id: orgId, kind, id }, thing });
  }
  const offerIds = await sendOffers(link, userId, items);
  const to = link.peer_name ?? "them";
  for (const [i, it] of items.entries()) {
    const s = it.source as RecordSource;
    await platform().entities.mergeMetadata(orgId, s.kind, s.id, { [RECORD_OFFER_KEY]: { offer_id: offerIds[i], to } });
  }
  return { ok: true, offered: items.length, to };
}

/** Offer rows of a share space's scan inbox to its sharer. */
export async function offerInboxItems(
  orgId: string,
  inboxIds: string[],
  opts: { userId: string },
): Promise<{ ok: true; offered: number } | { ok: false; error: string }> {
  const link = await meta.selectFrom("share_links").select("id").where("org_id", "=", orgId).where("side", "=", "share").where("status", "=", "active").executeTakeFirst();
  if (!link) return { ok: false, error: "Only a shared workspace offers its scans to the person who shared it." };
  const row = await getShareLink(link.id);
  if (!row) return { ok: false, error: "That share has ended." };
  const items: Array<{ source: Source; thing: OfferedThing }> = [];
  for (const inboxId of inboxIds) {
    const thing = await intake().asThing(orgId, inboxId);
    if (!thing) return { ok: false, error: "One of those scans is no longer in the inbox." };
    items.push({ source: { org_id: orgId, inbox_id: inboxId }, thing });
  }
  await sendOffers(row, opts.userId, items);
  for (const it of items) await intake().mark(orgId, (it.source as InboxSource).inbox_id, "offered");
  return { ok: true, offered: items.length };
}

async function inRowFor(orgId: string, inboxId: string) {
  return meta
    .selectFrom("share_offers as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select(["o.id", "o.link_id", "o.peer_offer_id", "o.status", "o.landed", "l.side", "l.peer_name"])
    .where("o.direction", "=", "in")
    .where("l.org_id", "=", orgId)
    .where(sql<string>`o.landed->>'inbox_id'`, "=", inboxId)
    .executeTakeFirst();
}

const open = (s: string) => s === "offered" || s === "maybe";

/** Who an arrival is routed as: the person given, or the workspace's first
 *  owner or admin (whoever set the share up is one of them). */
async function routeAs(orgId: string, userId?: string): Promise<{ userId: string; orgSlug: string } | null> {
  const org = await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirst();
  if (!org) return null;
  const who =
    userId ??
    (
      await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("org_id", "=", orgId)
        .where("role", "in", ORG_ROLES.filter((r) => roleHoldsEveryCapability(r)))
        .orderBy("joined_at")
        .executeTakeFirst()
    )?.user_id;
  return who ? { userId: who, orgSlug: org.slug } : null;
}

/** A person answered an offer in their inbox (PlatformShares.decideOffer). */
export async function decideOffer(
  orgId: string,
  inboxId: string,
  decision: OfferDecision,
  opts: { userId: string; into?: string | null },
): Promise<{ ok: true; landed?: { orgId: string; inboxId: string } } | { ok: false; error: string }> {
  const row = await inRowFor(orgId, inboxId);
  if (!row) return { ok: false, error: "That is not an offer here." };
  if (!open(row.status)) return { ok: false, error: `That offer was already ${row.status}.` };
  const it = intake();
  let landed: Landed = row.landed as Landed;
  if (decision === "taken") {
    // In a share space, taking a thing means having it in a workspace of
    // your own; it stays in the share space only when asked to.
    if (row.side === "share" && opts.into && opts.into !== orgId) {
      const member = await meta.selectFrom("org_memberships").select("org_id").where("org_id", "=", opts.into).where("user_id", "=", opts.userId).executeTakeFirst();
      if (!member) return { ok: false, error: "You can only take it into a workspace of yours." };
      const thing = await it.asThing(orgId, inboxId);
      if (!thing) return { ok: false, error: "That offer is no longer in the inbox." };
      const [moved] = await it.receive(opts.into, {
        session: { key: `share-take:${row.id}`, label: `From ${row.peer_name ?? "a share"}`, from: row.peer_name ?? "" },
        things: [{ offer_id: row.id, thing }],
        acquiredFrom: row.peer_name ?? "",
        acquiredOn: await platform().accounts.dayFor(opts.userId),
        as: await routeAs(opts.into, opts.userId),
      });
      await it.remove(orgId, inboxId);
      if (moved) {
        landed = { org_id: opts.into, inbox_id: moved.inbox_id };
        await it.mark(opts.into, moved.inbox_id, "taken");
      }
    } else {
      await it.mark(orgId, inboxId, "taken");
    }
  } else if (decision === "passed") {
    await it.remove(orgId, inboxId);
  } else {
    await it.mark(orgId, inboxId, "maybe");
  }
  await meta
    .updateTable("share_offers")
    .set({ status: decision, decided_at: new Date(), ...(decision === "taken" ? { taken_at: new Date() } : {}), landed: JSON.stringify(landed) as never })
    .where("id", "=", row.id)
    .execute();
  await enqueueShareOp(row.link_id, "offer.decided", { offer_id: row.peer_offer_id, decision, by_name: await nameOf(opts.userId) }, `offer.decided:${row.id}:${decision}:${Date.now()}`);
  return { ok: true, ...(landed.org_id !== orgId ? { landed: { orgId: landed.org_id, inboxId: landed.inbox_id } } : {}) };
}

async function offerRow(orgId: string, offerId: string) {
  return meta
    .selectFrom("share_offers as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select(["o.id", "o.link_id", "o.direction", "o.peer_offer_id", "o.status", "o.source", "o.landed", "o.taken_at", "l.peer_name", "l.org_id"])
    .where("o.id", "=", offerId)
    .executeTakeFirst()
    // The share's workspace, or the one a taken thing was taken into.
    .then((r) => (r && (r.org_id === orgId || (r.landed as Landed | null)?.org_id === orgId) ? r : null));
}

/** Only the people who can offer over a share may change its offers; the
 *  workspace the offer row hangs off is checked by the caller's tenant. */
export async function mayManageOffer(orgId: string, userId: string, offerId: string): Promise<boolean> {
  const r = await meta
    .selectFrom("share_offers as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select(["l.org_id", "l.side", "o.source"])
    .where("o.id", "=", offerId)
    .executeTakeFirst();
  if (!r) return false;
  if (r.org_id === orgId) return true;
  // A friend withdrawing what they offered from their own workspace.
  const src = r.source as Source | null;
  return !!src && src.org_id === orgId && (await offerTargets(orgId, userId)).length > 0;
}

/** The giver takes an open offer back. */
export async function withdrawOffer(orgId: string, offerId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await meta
    .selectFrom("share_offers")
    .select(["id", "link_id", "direction", "status", "source"])
    .where("id", "=", offerId)
    .executeTakeFirst();
  if (!row || row.direction !== "out" || !(await mayManageOffer(orgId, userId, offerId))) return { ok: false, error: "That is not an offer you made." };
  if (!open(row.status)) return { ok: false, error: `It was already ${row.status}.` };
  await meta.updateTable("share_offers").set({ status: "withdrawn", decided_at: new Date() }).where("id", "=", row.id).execute();
  await clearSourceMark(row.source as Source);
  await enqueueShareOp(row.link_id, "offer.withdrawn", { offer_id: row.id }, `offer.withdrawn:${row.id}`);
  return { ok: true };
}

/** The receiver gives a taken thing back, within SEND_BACK_DAYS. */
export async function sendBack(orgId: string, offerId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await offerRow(orgId, offerId);
  if (!row || row.direction !== "in") return { ok: false, error: "That is not something you were given here." };
  if (row.status !== "taken" || !row.taken_at) return { ok: false, error: "Only a thing you took can be sent back." };
  if (Date.now() - row.taken_at.getTime() > SEND_BACK_DAYS * 86_400_000) return { ok: false, error: `It can be sent back within ${SEND_BACK_DAYS} days of taking it.` };
  const landed = row.landed as Landed | null;
  if (landed) {
    const it = intake();
    const st = await it.state(landed.org_id, landed.inbox_id);
    if (st.status === "waiting") await it.remove(landed.org_id, landed.inbox_id);
    else if (st.status === "filed" && st.record) {
      const r = await markGone(landed.org_id, userId, st.record.kind, [st.record.id], { how: "given-away", to: row.peer_name, note: "Sent back" });
      if (!r.ok) return { ok: false, error: r.error };
    }
  }
  await meta.updateTable("share_offers").set({ status: "returned", decided_at: new Date() }).where("id", "=", row.id).execute();
  await enqueueShareOp(row.link_id, "offer.returned", { offer_id: row.peer_offer_id }, `offer.returned:${row.id}`);
  return { ok: true };
}

/** The hand-over a record here came from, while it can still be sent back:
 *  so the record itself offers Send back, not only Settings, Sharing (#4684). */
export async function receivedOffer(orgId: string, id: string): Promise<{ offer_id: string; from: string | null; until: string } | null> {
  const since = new Date(Date.now() - SEND_BACK_DAYS * 86_400_000);
  const rows = await meta
    .selectFrom("share_offers as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select(["o.id", "o.landed", "o.taken_at", "l.peer_name"])
    .where("o.direction", "=", "in")
    .where("o.status", "=", "taken")
    .where("o.taken_at", ">", since)
    .where(sql<string>`(o.landed->>'org_id')`, "=", orgId)
    .execute();
  if (!rows.length) return null;
  const it = platform().scan.offerIntake();
  if (!it) return null;
  for (const r of rows) {
    const landed = r.landed as Landed;
    const st = await it.state(landed.org_id, landed.inbox_id).catch(() => null);
    if (st?.status === "filed" && st.record?.id === id) {
      return { offer_id: r.id, from: r.peer_name, until: new Date(r.taken_at!.getTime() + SEND_BACK_DAYS * 86_400_000).toISOString() };
    }
  }
  return null;
}

async function clearSourceMark(src: Source | null): Promise<void> {
  if (!src) return;
  if (isRecord(src)) await platform().entities.mergeMetadata(src.org_id, src.kind, src.id, { [RECORD_OFFER_KEY]: null }).catch(() => undefined);
  else await intake().mark(src.org_id, src.inbox_id, "withdrawn").catch(() => undefined);
}

export interface OfferView {
  id: string;
  direction: "out" | "in";
  title: string;
  status: OfferState;
  peer_name: string | null;
  created_at: Date;
  taken_at: Date | null;
  can_withdraw: boolean;
  can_send_back: boolean;
}

/** What has been handed over through this workspace's shares, newest first. */
export async function listOffers(orgId: string): Promise<OfferView[]> {
  const rows = await meta
    .selectFrom("share_offers as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select(["o.id", "o.direction", "o.title", "o.status", "o.created_at", "o.taken_at", "l.peer_name"])
    .where((eb) => eb.or([eb("l.org_id", "=", orgId), eb(sql<string>`o.source->>'org_id'`, "=", orgId)]))
    .orderBy("o.created_at", "desc")
    .limit(200)
    .execute();
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    title: r.title,
    status: r.status as OfferState,
    peer_name: r.peer_name,
    created_at: r.created_at,
    taken_at: r.taken_at,
    can_withdraw: r.direction === "out" && open(r.status),
    can_send_back: r.direction === "in" && r.status === "taken" && !!r.taken_at && now - r.taken_at.getTime() <= SEND_BACK_DAYS * 86_400_000,
  }));
}

/** What the other side of a share says about offers. */
/** A taken hand-over, filed: the record says who it came from (#4683). Its
 *  History reads "<them> gave you <it> · through your share" whatever its
 *  fields, and where its collection keeps provenance (Acquired from, Acquired
 *  on), those are filled, unless someone already did. */
async function noteHandedOverFiled(p: { orgId?: unknown; itemId?: unknown; targetModule?: unknown; targetKind?: unknown; entityId?: unknown }): Promise<void> {
  const orgId = typeof p.orgId === "string" ? p.orgId : "";
  const itemId = typeof p.itemId === "string" ? p.itemId : "";
  const entityId = typeof p.entityId === "string" ? p.entityId : "";
  if (!orgId || !itemId || !entityId || typeof p.targetModule !== "string" || typeof p.targetKind !== "string") return;
  const row = await meta
    .selectFrom("share_offers as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select(["o.taken_at", "l.peer_name"])
    .where("o.direction", "=", "in")
    .where("o.status", "=", "taken")
    .where(sql<string>`(o.landed->>'org_id')`, "=", orgId)
    .where(sql<string>`(o.landed->>'inbox_id')`, "=", itemId)
    .executeTakeFirst();
  if (!row) return;
  const from = row.peer_name ?? "someone you share with";
  const kind = p.targetKind.includes(":") ? p.targetKind : `${p.targetModule}:${p.targetKind}`;
  const [module, entityType] = kind.split(":", 2);
  await platform().activity.log({ orgId, userId: null, action: "record_handed_over", ref: { module: module ?? null, entityType: entityType ?? kind, entityId }, via: { kind: "share", label: from } });
  const roles = new Map((await resolveFieldDefsForKind(orgId, kind).catch(() => [])).map((d) => [d.field_role, d.name] as const));
  const rec = await lookup(orgId, kind, entityId).catch(() => null);
  const have = ((rec?.fields as Record<string, unknown> | undefined)?.metadata ?? {}) as Record<string, unknown>;
  const fill: Record<string, unknown> = {};
  const fromField = roles.get(PROVENANCE_FIELDS.from.field_role);
  const onField = roles.get(PROVENANCE_FIELDS.on.field_role);
  if (fromField && !have[fromField]) fill[fromField] = from;
  if (onField && !have[onField] && row.taken_at) fill[onField] = await platform().accounts.dayFor(null, { now: row.taken_at });
  if (Object.keys(fill).length) await platform().entities.mergeMetadata(orgId, kind, entityId, fill).catch(() => undefined);
}

export function registerShareOfferOps(): void {
  platform().events.on("core-scan.scan.confirmed", "platform", (payload) => noteHandedOverFiled((payload ?? {}) as Record<string, unknown>).catch((err) => console.error("[share] noting a hand-over filed failed:", (err as Error).message)));
  // A thing offered: it lands in this side's scan inbox, as an offer.
  registerShareOp("offer.create", async (link, p) => {
    const offerId = String(p.offer_id ?? "");
    const thing = p.thing as OfferedThing | undefined;
    if (!offerId || !thing?.name) throw new Error("an offer without its thing");
    const existing = await meta.selectFrom("share_offers").select("id").where("link_id", "=", link.id).where("peer_offer_id", "=", offerId).executeTakeFirst();
    if (existing) return;
    const from = (typeof p.from_name === "string" && p.from_name) || link.peer_name || "them";
    const row = await meta
      .insertInto("share_offers")
      .values({ link_id: link.id, direction: "in", peer_offer_id: offerId, batch: String(p.batch ?? offerId), title: thing.name.slice(0, 300) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const [landed] = await intake().receive(link.org_id, {
      session: { key: `share:${link.id}:${String(p.batch ?? offerId)}`, label: `Offered by ${from}`, from },
      things: [{ offer_id: row.id, thing }],
      acquiredFrom: from,
      acquiredOn: await platform().accounts.dayFor(null),
      as: await routeAs(link.org_id),
    });
    if (landed) await meta.updateTable("share_offers").set({ landed: JSON.stringify({ org_id: link.org_id, inbox_id: landed.inbox_id }) as never }).where("id", "=", row.id).execute();
  });

  // The other side answered one of ours.
  registerShareOp("offer.decided", async (link, p) => {
    const decision = p.decision as OfferDecision;
    const row = await meta.selectFrom("share_offers").select(["id", "source", "status"]).where("id", "=", String(p.offer_id ?? "")).where("link_id", "=", link.id).where("direction", "=", "out").executeTakeFirst();
    if (!row || !open(row.status)) return;
    await meta
      .updateTable("share_offers")
      .set({ status: decision, decided_at: new Date(), ...(decision === "taken" ? { taken_at: new Date() } : {}) })
      .where("id", "=", row.id)
      .execute();
    const src = row.source as Source | null;
    if (!src || decision === "maybe") return;
    if (decision === "passed") return clearSourceMark(src);
    // Taken: theirs now. A record is given away to them (history kept); a
    // scan that had not been filed leaves the inbox.
    if (isRecord(src)) {
      await platform().entities.mergeMetadata(src.org_id, src.kind, src.id, { [RECORD_OFFER_KEY]: null }).catch(() => undefined);
      const r = await markGone(src.org_id, null, src.kind, [src.id], { how: "given-away", to: link.peer_name });
      if (!r.ok) throw new Error(r.error);
    } else {
      await intake().remove(src.org_id, src.inbox_id);
    }
  });

  // The giver took an open offer back.
  registerShareOp("offer.withdrawn", async (link, p) => {
    const row = await meta.selectFrom("share_offers").select(["id", "status", "landed"]).where("link_id", "=", link.id).where("peer_offer_id", "=", String(p.offer_id ?? "")).where("direction", "=", "in").executeTakeFirst();
    if (!row || !open(row.status)) return;
    const landed = row.landed as Landed | null;
    if (landed) {
      const st = await intake().state(landed.org_id, landed.inbox_id);
      if (st.status === "waiting") await intake().remove(landed.org_id, landed.inbox_id);
    }
    await meta.updateTable("share_offers").set({ status: "withdrawn", decided_at: new Date() }).where("id", "=", row.id).execute();
  });

  // The receiver sent a taken thing back: it is the giver's again.
  registerShareOp("offer.returned", async (link, p) => {
    const row = await meta.selectFrom("share_offers").select(["id", "source", "status"]).where("id", "=", String(p.offer_id ?? "")).where("link_id", "=", link.id).where("direction", "=", "out").executeTakeFirst();
    if (!row || row.status !== "taken") return;
    await meta.updateTable("share_offers").set({ status: "returned", decided_at: new Date() }).where("id", "=", row.id).execute();
    const src = row.source as Source | null;
    if (!src) return;
    if (isRecord(src)) {
      const r = await bringBack(src.org_id, null, src.kind, [src.id]);
      if (!r.ok) throw new Error(r.error);
    } else {
      await intake().restore(src.org_id, src.inbox_id);
    }
  });
}

