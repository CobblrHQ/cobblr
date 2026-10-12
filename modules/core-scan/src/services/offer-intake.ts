// The scan inbox's side of a share's hand-over (OfferIntake in
// @cobblr/platform-contract/share-offer; docs/design-decisions/share-spaces.md).
//
// Things someone offers arrive here as one session ("Offered by Vic"), each a
// row that already knows what it is (no identify runs: the giver's record
// said it), marked as an offer so its card asks Take / Pass / Maybe later.
// Filed, it says where it came from through the same facts a receipt's seller
// does: Acquired from is the person, Acquired on the day it arrived.

import { arrivalCount } from "./filed-quantity.js";
import { TITLE_VARIANTS_KEY } from "@cobblr/platform-contract/display-identity";
import { fileThroughConfirm, BundleInstaller } from "./file-through-confirm.js";
import { routeWhereKept, type RouteCandidate } from "./kept-route.js";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { INBOX_OFFER_KEY, readInboxOffer, incomingThingForInbox, type OfferIntake, type OfferState, type OfferedThing } from "@cobblr/platform-contract/share-offer";
import type { CoreScanDB } from "../db.js";
import { intakeRow } from "./intake.js";
import { assembleScanMenu, heuristicMatch, perceiveRow, type ScanMenuEntry } from "./matchmaker.js";
import { INTERNAL_API } from "../api/inbox.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";

/** What a row offered FROM here carries: offered to someone, and how it stands. */
const GIVEN_KEY = "share_offered";

/** Which table each arrival belongs in, worked out the way an import routes
 *  its rows (the heuristic over the workspace's tables, no AI), and the two
 *  stamps the inbox reads to know identifying and routing are done. A row
 *  stamped with no candidate asks the person for a table. */
async function routeArrivals(db: Kysely<CoreScanDB>, orgId: string, ids: string[], as: { userId: string; orgSlug: string } | null): Promise<void> {
  let menu: ScanMenuEntry[] = [];
  if (as) {
    try {
      const token = await platform().auth.mintSession({ userId: as.userId });
      menu = await assembleScanMenu(INTERNAL_API, as.orgSlug, token, orgId);
    } catch (err) {
      console.error("[core-scan] offer intake: could not read the table menu:", (err as Error).message);
    }
  }
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "barcode_text", "suggested_manufacturer", "suggested_sku", "ai_notes", "scan_area", "suggested_metadata", "suggested_candidates"])
    .where("id", "in", ids)
    .execute();
  const at = new Date();
  for (const row of rows) {
    let candidates: unknown[] = [];
    if (menu.length && row.suggested_name) {
      try {
        candidates = heuristicMatch(perceiveRow(row as Parameters<typeof perceiveRow>[0]), menu);
        // The collection the giver kept it in is where the receiver keeps
        // the same collection: the kept-route rule, the most specific first,
        // so a 3D printer files into 3D Printers, not generic Machines (#4682).
        const offered = (row.suggested_metadata as { offered_collection?: { module?: string; instance?: string | null } } | null)?.offered_collection;
        if (offered?.module) routeWhereKept(candidates as RouteCandidate[], menu, { twins: [{ module: offered.module, instance: offered.instance ?? null }] });
      } catch (err) {
        console.error("[core-scan] offer intake: routing threw for one row:", (err as Error).message);
      }
    }
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_suggested_at: at,
        updated_at: at,
        suggested_metadata: sql`jsonb_build_object('matched_at', ${at.toISOString()}::text) || coalesce(suggested_metadata, '{}'::jsonb)` as never,
        ...(candidates.length ? { suggested_candidates: sql`${JSON.stringify(candidates)}::jsonb` as never } : {}),
      })
      .where("id", "=", row.id)
      .execute();
  }
}

const dbFor = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<CoreScanDB>;

const fieldKey = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

async function storePhoto(orgId: string, p: { mime: string; data: string }, name: string): Promise<string | null> {
  try {
    const bytes = Buffer.from(p.data, "base64");
    const ext = p.mime.split("/")[1] ?? "jpg";
    const w = await platform().files.write(orgId, new Uint8Array(bytes), { filename: `${fieldKey(name) || "photo"}.${ext}`, mimeType: p.mime });
    return w?.fileId ?? null;
  } catch {
    return null;
  }
}

async function readPhoto(orgId: string, fileId: unknown): Promise<{ mime: string; data: string } | null> {
  if (typeof fileId !== "string" || !fileId) return null;
  const got = (await platform().files.read(orgId, fileId, "medium").catch(() => null)) ?? (await platform().files.read(orgId, fileId, "original").catch(() => null));
  return got ? { mime: got.mimeType, data: Buffer.from(got.bytes).toString("base64") } : null;
}

const metaOf = (v: unknown): Record<string, unknown> =>
  typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v as Record<string, unknown> | null) ?? {});

export const offerIntake: OfferIntake = {
  async room(orgId, as, p) {
    const blocked: string[] = [];
    const records = await platform().entitlements.check({ orgId, userId: as.userId, feature: "records.create", quantity: p.count });
    if (!records.allow) blocked.push(records.reason ?? "This send exceeds this workspace's record limit.");
    if (p.bytes) {
      const token = await platform().auth.mintSession({ userId: as.userId });
      const res = await apiFetch(`${INTERNAL_API}/api/v1/orgs/${as.orgSlug}/modules/core-files/files/usage`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("The target's file storage could not be checked.");
      const usage = await res.json() as { bytes_used: number; quota_bytes: number | null };
      const files = await platform().entitlements.check({ orgId, userId: as.userId, feature: "files.upload", quantity: p.bytes, used: usage.bytes_used });
      if (!files.allow) blocked.push(files.reason ?? "This send exceeds this workspace's storage limit.");
      if (usage.quota_bytes && usage.bytes_used + p.bytes > usage.quota_bytes) blocked.push("This send exceeds this workspace's storage limit.");
    }
    return blocked;
  },
  async receive(orgId, p) {
    const db = await dbFor(orgId);
    let batchId = (await db.selectFrom("core_scan_batches").select("id").where("import_source_id", "=", p.session.key).executeTakeFirst())?.id;
    if (!batchId) {
      batchId = (
        await db
          .insertInto("core_scan_batches")
          .values({ label: p.session.label, origin: "share", origin_from: p.session.from || null, import_source_id: p.session.key })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    }
    const out: Array<{ offer_id: string; inbox_id: string }> = [];
    const made: string[] = [];
    for (const { offer_id, thing: arrival } of p.things) {
      const thing = incomingThingForInbox(arrival, p.own);
      const there = await db
        .selectFrom("core_scan_inbox_items")
        .select("id")
        .where(sql<string>`suggested_metadata->${INBOX_OFFER_KEY}->>'offer_id'`, "=", offer_id)
        .executeTakeFirst();
      if (there) {
        out.push({ offer_id, inbox_id: there.id });
        continue;
      }
      const photoIds: string[] = [];
      for (const ph of thing.photos.slice(0, 4)) {
        const id = await storePhoto(orgId, ph, thing.name);
        if (id) photoIds.push(id);
      }
      const userFields: Record<string, string> = {};
      for (const [label, value] of Object.entries(thing.fields ?? {})) {
        const k = fieldKey(label);
        if (k) userFields[k] = value;
      }
      if (thing.notes) userFields.notes = thing.notes;
      const sentFiles = [];
      for (const f of thing.send?.files ?? []) {
        const stored = await platform().files.write(orgId, new Uint8Array(Buffer.from(f.data, "base64")), { filename: f.filename, mimeType: f.mime });
        if (!stored) throw new Error(`Could not store ${f.filename}. Nothing was sent.`);
        if (f.mime.startsWith("image/")) photoIds.push(stored.fileId);
        sentFiles.push({ fileId: stored.fileId, role: f.role, sort_order: f.sort_order });
      }
      const metadata = {
        [INBOX_OFFER_KEY]: { offer_id, from: p.acquiredFrom, state: "offered" satisfies OfferState, ...(thing.send ? { own: true, mode: thing.send.mode, needs: thing.send.needs } : {}) },
        ...(thing.send ? { send: { ...thing.send, files: sentFiles }, user_fields: { kind: thing.send.target_kind, values: thing.send.mapped } } : {}),
        // Filed, these say where it came from (receipt-facts: Acquired from,
        // Acquired on), the same way a receipt's seller does.
        receipt_seller: p.acquiredFrom,
        receipt_date: p.acquiredOn,
        ...(!thing.send ? { user_fields: userFields } : {}),
        offered_fields: thing.fields ?? {},
        // A titled work's other forms ride to the record the way an identified
        // scan's do (filing reads them from here), so the copy keeps them (#5958).
        ...(thing.title_variants ? { [TITLE_VARIANTS_KEY]: thing.title_variants } : {}),
        // A copy of a record that had none: held until someone says how many
        // arrived, never offered ready to Add as one.
        ...(arrivalCount(thing.quantity, { own: !!thing.send }).held ? { check_fields: { fields: ["quantity"], said: `This had a count of 0 in ${p.acquiredFrom ?? "the other workspace"}. Enter how many arrived.` } } : {}),
        ...(thing.kind_words ? { offered_kind: thing.kind_words } : {}),
        ...(thing.collection?.module ? { offered_collection: thing.collection } : {}),
        ...(photoIds.length > 1 ? { extra_photos: photoIds.slice(1) } : {}),
      };
      const ins = await intakeRow({
        db,
        orgId,
        // An import-shaped row runs no pass, so nothing reads these.
        orgSlug: "",
        userId: null,
        token: null,
        baseUrl: "",
        door: "import",
        values: {
          source_kind: "note",
          status: "pending",
          suggested_name: thing.name,
          suggested_manufacturer: thing.manufacturer ?? null,
          // The count the record had, as the inbox can hold it (one or more,
          // filed-quantity.ts); a known 0 is held for its count below (#5935).
          quantity: arrivalCount(thing.quantity, { own: !!thing.send }).quantity,
          scan_batch_id: batchId,
          ...(photoIds[0] ? { image_file_id: photoIds[0] } : {}),
          suggested_metadata: JSON.stringify(metadata) as never,
        } as never,
      });
      out.push({ offer_id, inbox_id: ins.row.id });
      made.push(ins.row.id);
    }
    if (made.length) await routeArrivals(db, orgId, made, p.as ?? null);
    for (const entry of out) {
      const thing = p.things.find((t) => t.offer_id === entry.offer_id)?.thing;
      if (!p.own || !thing?.send?.target_kind) continue;
      const kind = thing.send.target_kind;
      const resolved = await platform().entities.resolveKind(orgId, kind);
      const module = resolved.base.split(":")[0]!;
      await db.updateTable("core_scan_inbox_items").set({ suggested_candidates: JSON.stringify([{ kind, module, instance: resolved.instance, fields: thing.send.mapped, label: thing.collection?.instance ?? thing.kind_words }]) as never }).where("id", "=", entry.inbox_id).execute();
    }
    return out;
  },

  async file(orgId, inboxId, as) {
    const state = await offerIntake.state(orgId, inboxId);
    if (state.status === "filed" && state.record) return state.record;
    const db = await dbFor(orgId);
    const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", inboxId).executeTakeFirstOrThrow();
    const meta = metaOf(row.suggested_metadata);
    const token = await platform().auth.mintSession({ userId: as.userId });
    const door = { baseUrl: INTERNAL_API, slug: as.orgSlug, authHeaders: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, canInstall: false };
    const sent = meta.send as NonNullable<OfferedThing["send"]> | undefined;
    const filed = await fileThroughConfirm(door, new BundleInstaller(door), row, sent?.location ?? null);
    if (!filed.ok || !filed.entity_id || !filed.entity_kind) throw new Error(!filed.ok ? filed.reason : "The item did not file.");
    await finishOwnSend(orgId, inboxId, { kind: filed.entity_kind, id: filed.entity_id });
    return { kind: filed.entity_kind, id: filed.entity_id };
  },

  async retarget(orgId, inboxId, record) {
    const db = await dbFor(orgId);
    const {base} = await platform().entities.resolveKind(orgId, record.kind);
    const [module] = base.split(":");
    await db.updateTable("core_scan_inbox_items").set({ status: "resolved", target_module: module!, target_kind: record.kind, target_entity_id: record.id, updated_at: new Date() }).where("id", "=", inboxId).execute();
    return finishOwnSend(orgId, inboxId, record);
  },

  async state(orgId, inboxId) {
    const db = await dbFor(orgId);
    const row = await db.selectFrom("core_scan_inbox_items").select(["status", "target_module", "target_kind", "target_entity_id"]).where("id", "=", inboxId).executeTakeFirst();
    if (!row || row.status === "discarded") return { status: "gone" };
    if (row.status === "resolved") {
      // The row keeps the kind bare ("asset") beside its module; the record's
      // kind is the two together, or Send back of a filed thing could not
      // find it ("asset records cannot be marked as given away", #4684).
      const kind = row.target_kind && !row.target_kind.includes(":") && row.target_module ? `${row.target_module}:${row.target_kind}` : row.target_kind;
      return kind && row.target_entity_id ? { status: "filed", record: { kind, id: row.target_entity_id } } : { status: "gone" };
    }
    return { status: "waiting" };
  },

  async mark(orgId, inboxId, state) {
    const db = await dbFor(orgId);
    const row = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", inboxId).executeTakeFirst();
    if (!row) return;
    const meta = metaOf(row.suggested_metadata);
    const received = readInboxOffer(meta);
    const patch = received
      ? { [INBOX_OFFER_KEY]: { ...received, state } }
      : { [GIVEN_KEY]: state === "withdrawn" || state === "passed" ? null : { state } };
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` as never, updated_at: new Date() })
      .where("id", "=", inboxId)
      .execute();
  },

  async remove(orgId, inboxId) {
    const db = await dbFor(orgId);
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", updated_at: new Date() })
      .where("id", "=", inboxId)
      .where("status", "in", ["pending", "enriching"])
      .returning("id")
      .executeTakeFirst();
    return !!r;
  },

  async restore(orgId, inboxId) {
    const db = await dbFor(orgId);
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "pending",
        updated_at: new Date(),
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) - ${GIVEN_KEY}` as never,
      })
      .where("id", "=", inboxId)
      .where("status", "=", "discarded")
      .returning("id")
      .executeTakeFirst();
    return !!r;
  },

  async asThing(orgId, inboxId) {
    const db = await dbFor(orgId);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["status", "suggested_name", "suggested_manufacturer", "quantity", "image_file_id", "catalog_image_file_id", "suggested_metadata"])
      .where("id", "=", inboxId)
      .executeTakeFirst();
    if (!row || row.status === "discarded" || !row.suggested_name) return null;
    const meta = metaOf(row.suggested_metadata);
    const uf = (meta.user_fields && typeof meta.user_fields === "object" ? meta.user_fields : {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries((meta.offered_fields as Record<string, unknown> | undefined) ?? uf)) {
      if (k !== "notes" && (typeof v === "string" || typeof v === "number")) fields[k] = String(v);
    }
    const photos: OfferedThing["photos"] = [];
    const extra = Array.isArray(meta.extra_photos) ? meta.extra_photos : [];
    for (const id of [row.image_file_id, row.catalog_image_file_id, ...extra].slice(0, 4)) {
      const ph = await readPhoto(orgId, id);
      if (ph) photos.push(ph);
    }
    return {
      name: row.suggested_name,
      manufacturer: row.suggested_manufacturer,
      quantity: row.quantity ?? null,
      notes: typeof uf.notes === "string" ? uf.notes : null,
      kind_words: typeof meta.offered_kind === "string" ? meta.offered_kind : null,
      fields,
      photos,
    };
  },
};


export async function finishOwnSend(orgId: string, inboxId: string, record: { kind: string; id: string }): Promise<string[]> {
  const db = await dbFor(orgId);
  const row = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", inboxId).executeTakeFirst();
  const metadata = metaOf(row?.suggested_metadata);
  const sent = metadata.send as { origin: unknown; files: Array<{ fileId: string; role: string | null; sort_order: number }> } | undefined;
  if (!sent) return [];
  const resolved = await platform().entities.resolveKind(orgId, record.kind);
  const [module, type] = resolved.base.split(":");
  const added: string[] = [];
  for (const f of sent.files) {
    const attached = await platform().files.attach(orgId, { ...f, source_module: module!, source_type: type!, source_id: record.id });
    if (!attached) throw new Error("The received files could not be attached.");
    if (!attached.existed) added.push(attached.attachmentId);
  }
  const got = await platform().entities.lookup(orgId, record.kind, record.id);
  const old = (got?.fields?.metadata as Record<string, unknown> | undefined)?.send_origin;
  if (JSON.stringify(old) !== JSON.stringify(sent.origin)) await platform().entities.mergeMetadata(orgId, record.kind, record.id, { send_origin: sent.origin });
  const offer = readInboxOffer(metadata);
  if (offer?.own) await platform().shares.recordOwnSendFiling?.(orgId, offer.offer_id, inboxId, record);
  return added;
}
