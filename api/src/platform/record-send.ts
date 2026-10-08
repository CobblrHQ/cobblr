import { handedRecord } from "./handed-record.js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { platform, type DefinedField, type EntityViewer, type EntityWriter, countOf } from "@cobblr/platform-contract";
import { canUndoOwnMove, sameSendSnapshot, mapOfferedFields, type OfferedThing } from "@cobblr/platform-contract/share-offer";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { createCapabilityForModule } from "@cobblr/platform-contract/create-capability";
import { meta } from "../db/meta.js";
import { getHistoryWriterFor } from "./history-store.js";
import { baseKindOf, listKindsForOrg, lookup, resolveKind } from "./entities.js";
import { markGone, bringBack } from "./dispositions.js";
import { listOffers, recordAsThing } from "./share-offers.js";
import { fileIdFromRawPath } from "./file-paths.js";
import { hiddenFieldsFor } from "./field-scope-projection.js";
import { provisionInstance, getInstance } from "./instances.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { createFieldDef, FieldDefCreate } from "./field-defs.js";
import { getOverrideConfig, upsertOverride } from "./entity-kind-overrides.js";
import { runSerialised } from "./exclusive.js";
import { restore as restoreDeletedSource, forget as forgetDeletedTarget, get as getDeletedSource, exclusive as lockDeletedSource } from "./deleted-records.js";
import { currentActor } from "../lib/request-context.js";
import { hereUrl } from "./share-links.js";
import { humanFieldLabel } from "@cobblr/platform-contract/display-identity";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

export interface SendRequest {
  entity_kind: string;
  ids: string[];
  target_org: string;
  collection?: string | null;
  mode: "copy" | "move";
  field_map?: Record<string, string | null>;
  include_secrets?: boolean;
  location?: string | null;
  placement?: "unplaced";
  duplicate?: "update" | "another";
  request_id?: string;
  dry_run?: boolean;
  create_matching?: boolean;
  add_fields?: string[];
}
export interface SendItemPreview {
  id: string;
  name: string;
  collection: string | null;
  mappings: Array<{ from: string; to: string | null }>;
  missing: string[];
  dropped: string[];
  needs: string[];
  duplicate: string | null;
  files: number;
  arrival: "collection" | "inbox";
}
export interface SendPreview { blocked?: string[]; items: SendItemPreview[]; target: { id: string; slug: string; name: string }; can_include_secrets: boolean; }
export class SendError extends Error {}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const admin = (role: string) => ["owner", "admin"].includes(role);

async function unrestrictedToken() {
  const actor = currentActor();
  if (actor?.apiTokenId) {
    const token = await meta.selectFrom("api_tokens").select(["org_id", "scopes", "access"]).where("id", "=", actor.apiTokenId).executeTakeFirst();
    // A connector or a key made for one workspace was granted that workspace;
    // writing into another with it would reach past the grant. So it is
    // refused, and the sentence names the way that works (mcp-server.md).
    if (!token || token.org_id || token.scopes?.length || token.access === "look") throw new SendError("This key reaches only one workspace, so it cannot send into another. Send from the app, or use a key made for all your workspaces (Configuration, API tokens).");
  }
}
async function membership(org: string, userId: string) {
  const row = await meta.selectFrom("org_memberships as m").innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.slug", "o.name", "o.kind", "m.role"]).where("m.user_id", "=", userId)
    .where(/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(org) ? "o.id" : "o.slug", "=", org).executeTakeFirst();
  if (!row || row.kind === "share") throw new SendError("Choose a workspace of your own.");
  return row;
}
async function mayCreate(orgId: string, userId: string, role: string, module: string) {
  if (!roleSatisfies(role, ["member"])) return false;
  const cap = createCapabilityForModule(module);
  return !cap || platform().auth.userHasCapability({ orgId, userId, role, actionId: cap });
}
/** Where this person can send from here, and their recent sends from here
 *  (the ids platform:undo-send takes). A key that cannot send answers why,
 *  with no destinations, rather than a list it would then refuse. */
export async function sendTargets(orgId: string, userId: string) {
  try {
    await unrestrictedToken();
  } catch (err) {
    if (err instanceof SendError) return { targets: [], sends: [], refused: err.message };
    throw err;
  }
  const rows = await meta.selectFrom("org_memberships as m").innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.slug", "o.name", "m.role"]).where("m.user_id", "=", userId).where("o.id", "!=", orgId).where("o.kind", "=", "workspace").execute();
  const targets = [];
  for (const row of rows) {
    if (!roleSatisfies(row.role, ["member"])) continue;
    const collections = [];
    for (const k of await listKindsForOrg(row.id)) {
      if (await mayCreate(row.id, userId, row.role, k.module_name)) collections.push({ kind: k.id, label: k.display_name_plural || k.display_name, module: k.module_name });
    }
    targets.push({ id: row.id, slug: row.slug, name: row.name, role: row.role, collections });
  }
  const sends = (await listOffers(orgId, userId))
    .filter((o) => o.send_mode && o.direction === "out")
    .slice(0, 20)
    .map((o) => ({ id: o.id, title: o.title, to: o.peer_name, mode: o.send_mode, status: o.status, sent_at: o.created_at, can_undo: o.can_undo === true }));
  return { targets, sends };
}

async function sendThing(orgId: string, userId: string, kind: string, id: string, viewer: EntityViewer, includeSecrets: boolean): Promise<OfferedThing> {
  if (await handedRecord(orgId, id)) throw new SendError("This record belongs to the receiving workspace. Undo that send before sending it again.");
  const ent = await lookup(orgId, kind, id, viewer);
  if (!ent) throw new SendError("One of these records is no longer here.");
  const writer = await sendWriter(orgId, kind, userId);
  const read = writer?.snapshot ?? writer?.read;
  const raw = read ? await read(orgId, id) : null;
  if (read && !raw) throw new SendError("That record does not belong to this workspace.");
  const f = raw ?? ent.fields;
  const defs = await sendFieldDefs(orgId, kind);
  const hidden = await hiddenFieldsFor(orgId, userId, viewer.role ?? "guest");
  const values: Record<string, unknown> = {};
  const omitted: string[] = [];
  const references: Array<{ label: string; value: unknown }> = [];
  const bag = object(f.metadata);
  for (const d of defs) {
    const value = d.native ? f[d.name] : bag[d.name] ?? f[d.name];
    if (value === null || value === undefined || value === "" || d.type === "computed") continue;
    if (hidden.has(d.name)) continue;
    if (d.type === "secret" && !includeSecrets) { omitted.push(`${d.display_label}: secret not included`); continue; }
    if (d.type === "secret") throw new SendError("Secret fields need the encrypted reveal service before they can travel.");
    if (["id", "created_at", "updated_at", "image_path", "instance", "metadata", "location_name"].includes(d.name)) continue;
    if (d.field_role === "location" || /^(location|holding|stock)_?id$/.test(d.name)) continue;
    if (["relation", "entity", "person", "member", "location"].includes(d.type) || d.name.endsWith("_id")) { references.push({ label: d.display_label || d.name, value }); continue; }
    values[d.display_label || d.name] = value;
  }
  const thing = await recordAsThing(orgId, kind, id);
  if (!thing) throw new SendError("One of these records is no longer here.");
  const base = await baseKindOf(orgId, kind);
  const [module, type] = base.split(":");
  const files: NonNullable<OfferedThing["send"]>["files"] = [];
  const attachments = await platform().files.listAttachments(orgId, { source_module: module!, source_type: type!, source_id: id });
  const ownPhoto = fileIdFromRawPath(f.image_path);
  const all = [...(attachments ?? [])];
  if (ownPhoto && !all.some((a) => a.fileId === ownPhoto)) all.unshift({ fileId: ownPhoto, filename: `${ent.title}.jpg`, role: "photo", sort_order: 0 } as typeof all[number]);
  for (const a of all) {
    const got = await platform().files.read(orgId, a.fileId, "original");
    if (!got) throw new SendError(`Could not read ${a.filename}. Nothing was sent.`);
    files.push({ filename: a.filename, role: a.role, sort_order: a.sort_order, mime: got.mimeType, data: Buffer.from(got.bytes).toString("base64") });
  }
  const mod = await meta.selectFrom("org_modules").select("version").where("org_id", "=", orgId).where("module_name", "=", module!).executeTakeFirst();
  return { ...thing, manufacturer: hidden.has("manufacturer") ? null : thing.manufacturer, model: hidden.has("model") ? null : thing.model, notes: hidden.has("notes") ? null : thing.notes, fields: {}, photos: [], send: { version: 1, mode: "copy", origin: { instance: hereUrl(), org: orgId, kind, id }, module_version: mod?.version ?? "0", kind_version: (await listKindsForOrg(orgId)).find((k) => k.id === kind)?.version ?? "1", values, references, files, needs: omitted, target_kind: null, mapped: {}, location: typeof f.location_id === "string" ? f.location_id : null } };
}

async function prepare(orgId: string, userId: string, p: SendRequest) {
  const source = await membership(orgId, userId);
  const target = await membership(p.target_org, userId);
  await unrestrictedToken();
  if (p.mode === "move" && !roleSatisfies(source.role, ["member"])) throw new SendError("You cannot move records from this read-only workspace.");
  if (target.id === source.id) throw new SendError("Choose a different workspace.");
  if (!roleSatisfies(target.role, ["member"])) throw new SendError("You can only send into a workspace where you can create records.");
  const canSecrets = admin(source.role) && admin(target.role);
  if (p.include_secrets && !canSecrets) throw new SendError("Only an owner or admin in both workspaces can include secrets.");
  if (p.mode === "move" && !roleSatisfies(source.role, ["member"])) throw new SendError("You cannot move records out of this workspace.");
  const viewer: EntityViewer = { userId, role: source.role };
  const kinds = await listKindsForOrg(target.id);
  const sourceKind = await resolveKind(source.id, p.entity_kind);
  const sourceShape = (await listKindsForOrg(source.id)).find((k) => k.id === p.entity_kind);
  if (p.mode === "move") {
    const writer = await sendWriter(source.id, p.entity_kind, userId);
    if (!canUndoOwnMove(writer)) throw new SendError("This collection can be copied, but cannot yet be moved safely.");
  }
  const things: Array<{ thing: OfferedThing; preview: SendItemPreview; defs: DefinedField[] }> = [];
  for (const id of p.ids) {
    const thing = await sendThing(source.id, userId, p.entity_kind, id, viewer, !!p.include_secrets);
    const s = thing.send!;
    s.mode = p.mode;
    if (p.mode === "move") await refuseUnsentDependents(source.id, p.entity_kind, id, userId);
    for (const ref of s.references ?? []) {
      const ids = Array.isArray(ref.value) ? ref.value : [ref.value];
      const replacements = [];
      for (const id of ids) {
        if (typeof id !== "string") break;
        const previous = await findSendArrival(target.id, {instance: s.origin.instance, org: source.id, id}, {userId, role: target.role});
        const landed = object(previous?.landed);
        const state = typeof landed.inbox_id === "string" ? await platform().scan.offerIntake()?.state(target.id, landed.inbox_id) : null;
        if (state?.status !== "filed" || !state.record || !await lookup(target.id, state.record.kind, state.record.id, {userId, role: target.role})) break;
        replacements.push(state.record.id);
      }
      if (replacements.length === ids.length) s.values[ref.label] = Array.isArray(ref.value) ? replacements : replacements[0];
      else s.needs.push(`${ref.label}: link not sent because the linked record is not in this workspace`);
    }
    const match = p.collection ? kinds.find((k) => k.id === p.collection) : kinds.find((k) => k.id === p.entity_kind && k.module_name === sourceKind.base.split(":")[0]) ?? kinds.find((k) => k.module_name === sourceKind.base.split(":")[0] && (sourceKind.instance ? k.display_name === sourceShape?.display_name : k.id === sourceKind.base));
    if (p.collection && !match) throw new SendError("That collection is not installed in the target workspace.");
    if (match && !(await mayCreate(target.id, userId, target.role, match.module_name))) throw new SendError("You cannot create records in that collection.");
    s.target_kind = match?.id ?? null;
    const defs = match ? await sendFieldDefs(target.id, match.id) : [];
    const sourceDefs = await sendFieldDefs(source.id, p.entity_kind);
    const virtual = [...defs];
    if (p.create_matching && !match) virtual.push(...sourceDefs);
    for (const label of p.add_fields ?? []) {
      const field = sourceDefs.find((d) => (d.display_label || d.name) === label);
      if (!field) throw new SendError(`There is no source field called ${label}.`);
      if (!virtual.some((d) => d.name === field.name)) virtual.push({ ...field, native: false });
    }
    if ((p.create_matching || p.add_fields?.length) && !roleSatisfies(target.role, ["admin"])) throw new SendError("An owner or admin can create the matching collection or add fields there.");
    const mapped = mapOfferedFields(s.values, virtual, p.field_map);
    s.mapped = mapped.values;
    s.field_map = p.field_map;
    const collectionName = match ? match.display_name_plural || match.display_name : p.create_matching ? sourceShape?.display_name_plural || sourceShape?.display_name || thing.kind_words || null : null;
    const needs = [...(match || p.create_matching ? [] : ["Choose or create a matching collection"]), ...mapped.missing.map((f) => `${f} has no field in ${collectionName ?? "the target collection"}`)];
    if (s.location && !p.location && p.placement !== "unplaced") needs.push("Choose a placement in this workspace");
    s.location = p.location ?? null;
    s.needs = [...s.needs, ...needs];
    const previous = await findSendArrival(target.id, s.origin, {userId, role: target.role});
    const preview: SendItemPreview = { id, name: thing.name, collection: collectionName, mappings: mapped.mappings, missing: mapped.missing, dropped: [...mapped.dropped, ...s.needs.filter((n) => !needs.includes(n))], needs, duplicate: previous?.id ?? null, files: s.files.length, arrival: needs.length ? "inbox" : "collection" };
    things.push({ thing, preview, defs });
  }
  const room = platform().scan.offerIntake()?.room;
  const blocked = room ? await room(target.id, { userId, orgSlug: target.slug }, { count: things.length, bytes: things.reduce((sum, i) => sum + i.thing.send!.files.reduce((n, f) => n + Buffer.byteLength(f.data, "base64"), 0), 0) }) : [];
  return { source, target, things, canSecrets, blocked };
}

export async function previewSend(orgId: string, userId: string, p: SendRequest): Promise<SendPreview> {
  const plan = await prepare(orgId, userId, p);
  return { blocked: plan.blocked, target: plan.target, can_include_secrets: plan.canSecrets, items: plan.things.map((i) => i.preview) };
}

type Transfer = { mode: "copy" | "move"; state: "landing" | "landed" | "complete" | "undoing" | "undone"; target_name: string; source_name: string; previous?: Record<string, unknown>; previous_id?: string; previous_kind?: string; source_deleted?: boolean; source_changed?: boolean; added_attachments?: string[]; target_after?: Record<string, unknown>; target_related?: unknown; target_record?: {kind: string; id: string}; batch_complete?: boolean; thing: OfferedThing };
async function save(id: string, transfer: Transfer, landed?: unknown) {
  await meta.updateTable("share_offers").set({ transfer: JSON.stringify(transfer) as never, ...(landed ? { landed: JSON.stringify(landed) as never } : {}), ...(transfer.state === "complete" ? { status: "taken" as const, taken_at: new Date(), decided_at: new Date() } : {}) }).where("id", "=", id).execute();
}

export async function recordOwnSendFiling(orgId: string, offerId: string, inboxId: string, record: { kind: string; id: string }): Promise<void> {
  const row = await meta.selectFrom("share_offers").selectAll().where("id", "=", offerId).where("target_org_id", "=", orgId).executeTakeFirst();
  if (!row || object(row.landed).inbox_id !== inboxId) return;
  const transfer = object(row.transfer);
  if (transfer.target_after || transfer.state === "undone") return;
  const state = await platform().scan.offerIntake()?.state(orgId, inboxId);
  if (state?.status !== "filed" || state.record?.id !== record.id || state.record.kind !== record.kind) return;
  const writer = await platform().entities.getWriter(orgId, record.kind) ?? await getHistoryWriterFor(orgId, record.kind);
  const after = await writer?.snapshot?.(orgId, record.id);
  if (!after) throw new SendError("The filed item could not be checked for Undo.");
  const baseline = { target_after: after, target_related: (await writer?.snapshotDeletion?.(orgId, record.id))?.related, target_record: record };
  await meta.updateTable("share_offers").set({transfer: sql`transfer || ${JSON.stringify(baseline)}::jsonb` as never})
    .where("id", "=", offerId).where(sql<boolean>`transfer->'target_after' IS NULL`).execute();
}

export async function sendRecords(orgId: string, userId: string, p: SendRequest) {
  if (p.dry_run) return previewSend(orgId, userId, p);
  return runSerialised(`record-send:${orgId}`, async () => {
    if (p.request_id) {
      const done = await meta.selectFrom("share_offers").selectAll().where("batch", "=", p.request_id).where("created_by", "=", userId).execute();
      if (done.length && done.every((r) => object(r.transfer).state === "complete" && object(r.transfer).batch_complete === true)) {
        await unrestrictedToken();
        const source = await membership(orgId, userId);
        if (p.mode === "move" && !roleSatisfies(source.role, ["member"])) throw new SendError("You cannot move records from this read-only workspace.");
        const target = await membership(p.target_org, userId);
        if (!roleSatisfies(target.role, ["member"])) throw new SendError("You cannot create records in the target workspace.");
        if (done.length !== p.ids.length || done.some((r) => r.target_org_id !== target.id || object(r.source).org_id !== orgId || object(r.source).kind !== p.entity_kind || !p.ids.includes(String(object(r.source).id)) || object(r.transfer).mode !== p.mode)) throw new SendError("That request id belongs to a different send.");
        return { ok: true, sent: done.length, offer_ids: p.ids.map((id) => done.find((r) => object(r.source).id === id)!.id), summary: `${countOf(done.length, "item")} ${p.mode === "copy" ? "copied" : "sent"} to ${target.name}.` };
      }
    }
    const first = await prepare(orgId, userId, p);
    if (first.blocked.length) throw new SendError(first.blocked.join(" "));
    await prepareTargetShape(orgId, userId, p);
    const plan = await prepare(orgId, userId, { ...p, create_matching: false, add_fields: [] });
    if (plan.things.some((i) => i.preview.duplicate) && !p.duplicate && !p.request_id) throw new SendError("These records were sent before. Update the earlier copy or make another.");
    const intake = platform().scan.offerIntake();
    if (!intake?.file) throw new SendError("The target needs its scan inbox enabled to receive this send.");
    const batch = p.request_id ?? randomUUID();
    const made: string[] = [];
    try {
    for (const { thing, preview } of plan.things) {
      const src = { org_id: orgId, kind: p.entity_kind, id: preview.id };
      let row = await meta.selectFrom("share_offers").selectAll().where("batch", "=", batch).where(sql<string>`(source->>'id')`, "=", preview.id).where("created_by", "=", userId).executeTakeFirst();
      if (row && object(row.transfer).state === "undone") throw new SendError("This send was undone. Preview again before sending it anew.");
      if (row && object(row.transfer).state === "complete") { made.push(row.id); continue; }
      if (!row && preview.duplicate && !p.duplicate) throw new SendError("These records were sent before. Update the earlier copy or make another.");
      const t: Transfer = row ? row.transfer as Transfer : { mode: p.mode, state: "landing", target_name: plan.target.name, source_name: plan.source.name, thing };
      if (!row) row = await meta.insertInto("share_offers").values({ link_id: null, target_org_id: plan.target.id, transfer: JSON.stringify(t) as never, direction: "out", batch, title: thing.name, source: JSON.stringify(src) as never, created_by: userId }).onConflict((oc) => oc.expression(sql`batch, (source->>'id')`).where("target_org_id", "is not", null).doUpdateSet({ batch })).returningAll().executeTakeFirstOrThrow();
      try {
        const [arrival] = await intake.receive(plan.target.id, { own: true, session: { key: `send:${batch}`, label: `${p.mode === "copy" ? "Copied" : "Sent"} from ${plan.source.name}`, from: plan.source.name }, things: [{ offer_id: row.id, thing: t.thing }], acquiredFrom: plan.source.name, acquiredOn: await platform().accounts.dayFor(userId), as: { userId, orgSlug: plan.target.slug } });
        if (!arrival) throw new SendError("The item did not arrive. The source is still here.");
        const landed = { org_id: plan.target.id, inbox_id: arrival.inbox_id };
        t.state = "landed";
        await save(row.id, t, landed);
        if (preview.duplicate && p.duplicate === "update") {
          const previous = await meta.selectFrom("share_offers").select("landed").where("id", "=", preview.duplicate).executeTakeFirstOrThrow();
          const earlier = object(previous.landed);
          const state = typeof earlier.inbox_id === "string" ? await intake.state(plan.target.id, earlier.inbox_id) : null;
          if (state?.status !== "filed" || !state.record) throw new SendError("The earlier copy is still in the inbox. File it before updating, or make another copy.");
          if (state.record.kind !== thing.send!.target_kind || preview.arrival !== "collection") throw new SendError("Choose the earlier copy's collection and resolve all fields before updating it.");
          const writer = await sendWriter(plan.target.id, state.record.kind, userId);
          const read = writer?.snapshot ?? writer?.read;
          if (!writer || !read) throw new SendError("This collection cannot yet undo an update safely. Make another copy instead.");
          if (!t.previous) {
            t.previous = await read(plan.target.id, state.record.id) ?? undefined;
            if (!t.previous) throw new SendError("The earlier copy no longer exists.");
            t.previous_id = state.record.id; t.previous_kind = state.record.kind;
            await save(row.id, t, landed);
          }
          const fields = { ...thing.send!.mapped };
          const metadata = { ...object(t.previous?.metadata) };
          for (const d of await sendFieldDefs(plan.target.id, state.record.kind)) if (!d.native && Object.hasOwn(fields, d.name)) { metadata[d.name] = fields[d.name]; delete fields[d.name]; }
          await writer.update(plan.target.id, state.record.id, { ...fields, metadata });
          if (!intake.retarget) throw new SendError("The inbox cannot yet update this copy safely.");
          t.added_attachments = await intake.retarget(plan.target.id, arrival.inbox_id, state.record);
          t.target_record = state.record;
          t.target_after = await read(plan.target.id, state.record.id) ?? undefined;
          await save(row.id, t, landed);
        } else if (preview.arrival === "collection") {
          t.target_record = await intake.file(plan.target.id, arrival.inbox_id, { userId, orgSlug: plan.target.slug });
          const writer = await sendWriter(plan.target.id, t.target_record.kind, userId);
          t.target_after = await writer?.snapshot?.(plan.target.id, t.target_record.id) ?? undefined;
          t.target_related = (await writer?.snapshotDeletion?.(plan.target.id, t.target_record.id))?.related;
          await save(row.id, t, landed);
        }
        if (p.mode === "move") {
          const writer = await sendWriter(orgId, p.entity_kind, userId);
          if (writer?.retire && writer.unretire) {
            t.source_changed = true;
            await save(row.id, t, landed);
            const moved = await markGone(orgId, userId, p.entity_kind, [preview.id], { how: "given-away", to: plan.target.name, note: "Sent to another workspace" });
            if (!moved.ok) throw new SendError(moved.error);
          } else if (writer) {
            await refuseUnsentDependents(orgId, p.entity_kind, preview.id, userId);
            t.source_changed = true;
            t.source_deleted = true;
            await save(row.id, t, landed);
            await writer.delete(orgId, preview.id);
          } else throw new SendError("The source collection is no longer enabled.");
        }
        t.state = "complete";
        await save(row.id, t, landed);
        
        await platform().activity.log({ orgId: plan.target.id, userId, action: "record_sent", diff: { name: thing.name, from: plan.source.name }, ref: t.target_record ? { module: (await baseKindOf(plan.target.id, t.target_record.kind)).split(":")[0]!, entityType: (await baseKindOf(plan.target.id, t.target_record.kind)).split(":")[1]!, entityId: t.target_record.id } : { module: "platform", entityType: "send", entityId: row.id } });
        made.push(row.id);
      } catch (err) {
        await undoSendUnlocked(orgId, userId, row.id);
        throw err;
      }
    }
    } catch (err) {
      for (const id of made.reverse()) await undoSendUnlocked(orgId, userId, id);
      throw err;
    }
    await meta.updateTable("share_offers").set({ transfer: sql`transfer || '{"batch_complete":true}'::jsonb` as never }).where("batch", "=", batch).where("created_by", "=", userId).execute();
    return { ok: true, sent: made.length, offer_ids: made, summary: `${made.length} ${made.length === 1 ? "item" : "items"} ${p.mode === "copy" ? "copied" : "sent"} to ${plan.target.name}.` };
  });
}

export async function undoSend(orgId: string, userId: string, offerId: string) {
  return runSerialised(`record-send:${orgId}`, () => undoSendUnlocked(orgId, userId, offerId));
}
export async function undoFileArrival(orgId: string, userId: string, offerId: string, checkOnly = false, locked = false) {
  const work = () => undoSendUnlocked(orgId, userId, offerId, false, false, true, checkOnly);
  return locked ? work() : runSerialised(`record-send:${orgId}`, work);
}
async function undoSendUnlocked(orgId: string, userId: string, offerId: string, onlyIncomplete = false, sourceLocked = false, targetOnly = false, checkOnly = false): Promise<{ok: true}> {
  const row = await meta.selectFrom("share_offers").selectAll().where("id", "=", offerId).where("target_org_id", "is not", null).executeTakeFirst();
  const incoming = object(row?.transfer).transport === "file-import";
  if (!row || (incoming ? row.target_org_id : object(row.source).org_id) !== orgId || row.created_by !== userId) throw new SendError("That is not a send you made here.");
  if ((incoming && !targetOnly && !onlyIncomplete) || (targetOnly && !incoming)) throw new SendError("Undo this file import in the receiving workspace.");
  const source = await membership(orgId, userId);
  if (!incoming && object(row.transfer).mode === "move" && !roleSatisfies(source.role, ["member"])) throw new SendError("You no longer have permission to undo in the source workspace.");
  await unrestrictedToken();
  const target = await membership(row.target_org_id!, userId);
  if (!roleSatisfies(target.role, ["member"])) throw new SendError("You no longer have permission to undo in the target workspace.");
  const t = row.transfer as Transfer;
  if (onlyIncomplete && t.state === "complete" && t.batch_complete) return { ok: true };
  if (t.state === "undone") return { ok: true };
  const src = object(row.source);
  let restoreSource = false;
  if (!incoming && t.mode === "move" && t.source_changed) {
    if (!sourceLocked) return lockDeletedSource(orgId, String(src.kind), String(src.id), () => undoSendUnlocked(orgId, userId, offerId, onlyIncomplete, true));
    const writer = await sendWriter(orgId, String(src.kind), userId);
    if (!writer) throw new SendError("The source collection needs to be enabled to undo.");
    const read = writer.snapshot ?? writer.read;
    const current = read ? await read(orgId, String(src.id)) : (await lookup(orgId, String(src.kind), String(src.id), {userId, role: source.role}))?.fields;
    restoreSource = !current || !!current.deleted_at;
    if (restoreSource && !await getDeletedSource(orgId, String(src.kind), String(src.id))) throw new SendError("The source restore is no longer available. Keep the received record.");
  }
  if (!checkOnly) { t.state = "undoing"; await save(row.id, t); }
  const landed = object(row.landed);
  const intake = platform().scan.offerIntake();
  if (!landed.inbox_id && intake && !checkOnly) {
    const [arrival] = await intake.receive(target.id, { own: true, session: { key: `send:${row.batch}`, label: `Sent from ${t.source_name}`, from: t.source_name }, things: [{offer_id: row.id, thing: t.thing}], acquiredFrom: t.source_name, acquiredOn: await platform().accounts.dayFor(userId), as: {userId, orgSlug: target.slug} });
    if (arrival) { landed.org_id = target.id; landed.inbox_id = arrival.inbox_id; await save(row.id, t, landed); }
  }
  if (t.previous_id && t.previous_kind && t.previous) {
    const writer = await sendWriter(target.id, t.previous_kind, userId);
    const read = writer?.snapshot ?? writer?.read;
    if (!writer || !read) throw new SendError("Enable the earlier copy's collection to undo.");
    if (t.target_after && !sameSendSnapshot(await read(target.id, t.previous_id), t.target_after)) throw new SendError("The earlier copy changed since the send. Undo would overwrite those changes.");
    if (!checkOnly) {
      for (const id of t.added_attachments ?? []) await platform().files.detach(target.id, id);
      if (writer.restore) await writer.restore(target.id, t.previous);
      else await writer.update(target.id, t.previous_id, t.previous);
    }
  }
  if (typeof landed.inbox_id === "string" && intake) {
    const state = await intake.state(target.id, landed.inbox_id);
    if (state.status === "filed" && state.record && !t.previous) {
      const writer = await sendWriter(target.id, state.record.kind, userId);
      if (!writer) throw new SendError("The receiving collection needs to be enabled to undo.");
      const current = await writer.snapshot?.(target.id, state.record.id);
      if (current && !t.target_after) throw new SendError("This item was filed after it arrived. Remove it here before undoing the send.");
      if (current && t.target_after && !sameSendSnapshot(current, t.target_after)) throw new SendError("The received record changed since the send. Keep those changes or remove it before undoing.");
      if (current && t.target_related !== undefined && !sameSendSnapshot((await writer.snapshotDeletion?.(target.id, state.record.id))?.related, t.target_related)) throw new SendError("The received record's related records changed since the send. Keep them or remove the arrival before undoing.");
      if (!checkOnly) {
        await writer.delete(target.id, state.record.id);
        await forgetDeletedTarget(target.id, state.record.kind, state.record.id);
      }
    } else if (state.status === "waiting" && !checkOnly) await intake.remove(target.id, landed.inbox_id);
  }
  if (checkOnly) return {ok: true};
  await meta.updateTable("share_offers").set({ status: "returned", decided_at: new Date() }).where("id", "=", row.id).execute();
  if (!incoming && t.mode === "move" && t.source_changed) {
    if (restoreSource && !await restoreDeletedSource(orgId, String(src.kind), String(src.id))) throw new SendError("The source restore is no longer available.");
    if (!t.source_deleted) {
      const r = await bringBack(orgId, userId, String(src.kind), [String(src.id)]);
      if (!r.ok) throw new SendError(r.error);
    }
  }
  t.state = "undone";
  await save(row.id, t);
  return { ok: true };
}


async function prepareTargetShape(orgId: string, userId: string, p: SendRequest): Promise<void> {
  if (!p.create_matching && !p.add_fields?.length) return;
  const target = await membership(p.target_org, userId);
  if (!roleSatisfies(target.role, ["admin"])) throw new SendError("You cannot change the target collection's fields.");
  const source = await resolveKind(orgId, p.entity_kind);
  const module = source.base.split(":")[0]!;
  const planned = await prepare(orgId, userId, p);
  const match = planned.things[0]?.thing.send?.target_kind;
  let kind = p.collection ?? match ?? p.entity_kind;
  if (p.create_matching && !match) {
    await enableModuleForOrg(target.id, module, { userId });
    if (source.instance && !(await getInstance(target.id, source.instance))) {
      const own = await getInstance(orgId, source.instance);
      if (!own) throw new SendError("The source collection no longer exists.");
      const made = await provisionInstance({ orgId: target.id, moduleName: module, instanceName: own.instance_name, displayName: own.display_name });
      if (!made.ok) throw new SendError(made.message);
      const config = await getOverrideConfig(orgId, "instance", source.instance);
      await upsertOverride({ orgId: target.id, targetKind: "instance", targetId: source.instance, config });
    }
  }
  const defs = await sendFieldDefs(orgId, p.entity_kind);
  const existing = await sendFieldDefs(target.id, kind);
  for (const d of defs) {
    if (d.type === "computed" || existing.some((e) => e.name === d.name) || (!p.create_matching && !p.add_fields?.includes(d.display_label || d.name))) continue;
    const parsed = FieldDefCreate.safeParse({ ...d, native: false, entity_kind: kind, required: false });
    if (!parsed.success) throw new SendError(`The ${d.display_label} field needs configuring in the target first.`);
    const result = await createFieldDef(target.id, parsed.data);
    if (!result.ok) throw new SendError(result.message);
  }
}


export function registerOwnSendRecovery(): void {
  platform().sweeps.register({
    name: "platform.own-workspace-send-recovery", everyMs: 60_000,
    async candidates() {
      const rows = await meta.selectFrom("share_offers").select(sql<string>`case when transfer->>'transport' = 'file-import' then target_org_id::text else source->>'org_id' end`.as("org_id")).where("target_org_id", "is not", null).where(sql<boolean>`(transfer->>'state' <> 'undone' and (transfer->>'state' <> 'complete' or transfer->>'batch_complete' is distinct from 'true'))`).execute();
      return [...new Set(rows.map((r) => r.org_id))];
    },
    async visit({ orgId }) {
      const rows = await meta.selectFrom("share_offers").select(["id", "created_by"]).where("target_org_id", "is not", null)
        .where(sql<string>`(case when transfer->>'transport' = 'file-import' then target_org_id::text else source->>'org_id' end)`, "=", orgId).where(sql<boolean>`(transfer->>'state' <> 'undone' and (transfer->>'state' <> 'complete' or transfer->>'batch_complete' is distinct from 'true'))`)
        .where("created_at", "<", new Date(Date.now() - 5 * 60_000)).limit(200).execute();
      for (const row of rows) if (row.created_by) await runSerialised(`record-send:${orgId}`, () => undoSendUnlocked(orgId, row.created_by!, row.id, true));
    },
  });
}


async function sendFieldDefs(orgId: string, kind: string): Promise<DefinedField[]> {
  const k = (await listKindsForOrg(orgId)).find((k) => k.id === kind);
  const custom = await platform().entities.fieldsFor(orgId, kind);
  const names = new Set(custom.map((f) => f.name));
  const native: DefinedField[] = (k?.fields ?? []).filter((f) => !f.readOnly && !names.has(f.name)).map((f) => ({ name: f.name, display_label: humanFieldLabel(f.name, f.label), type: f.type, native: true, field_role: f.fieldRole, required: f.required, choices: f.choices ?? null }));
  return [...native, ...custom.map((f) => ({...f, display_label: humanFieldLabel(f.name, f.display_label)}))];
}

async function sendWriter(orgId: string, kind: string, userId: string): Promise<EntityWriter | null> {
  const native = await platform().entities.getWriter(orgId, kind);
  if (native) return native;
  const history = await getHistoryWriterFor(orgId, kind);
  const shape = (await listKindsForOrg(orgId)).find((k) => k.id === kind);
  if (!history || !shape?.endpoints?.create || !shape.endpoints.update || !shape.endpoints.delete) return null;
  const org = await membership(orgId, userId);
  const token = await platform().auth.mintSession({userId});
  const call = async (method: string, endpoint: string, id?: string, fields?: Record<string, unknown>) => {
    const path = endpoint.replace(/\{id\}/g, id ?? "");
    const response = await apiFetch(`${selfOrigin()}/api/v1/orgs/${org.slug}/modules/${shape.module_name}${path}`, {
      method, headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      ...(fields ? {body: JSON.stringify(fields)} : {}), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null) as {id?: string; error?: {message?: string}} | null;
    if (!response.ok) throw new SendError(body?.error?.message ?? "The collection could not complete this send.");
    return body;
  };
  return {
    create: async (_org, fields) => {
      const body = await call("POST", shape.endpoints!.create!, undefined, fields);
      if (!body?.id) throw new SendError("The collection did not confirm the new record.");
      return body.id;
    },
    update: async (_org, id, fields) => { await call("PATCH", shape.endpoints!.update!, id, fields); },
    delete: async (_org, id) => { await call("DELETE", shape.endpoints!.delete!, id); },
    snapshot: history.snapshot.bind(history), read: history.snapshot.bind(history), restore: history.restore.bind(history),
    snapshotDeletion: history.snapshotDeletion?.bind(history), restoreDeletion: history.restoreDeletion?.bind(history),
  };
}

async function refuseUnsentDependents(orgId: string, kind: string, id: string, userId: string): Promise<void> {
  const writer = await sendWriter(orgId, kind, userId);
  if (writer?.retire && writer.unretire) return;
  const related = object((await writer?.snapshotDeletion?.(orgId, id))?.related);
  if ([related.rows, related.cleared].some((rows) => Array.isArray(rows) && rows.length)) throw new SendError("This record has related records that are not travelling. Copy it instead, or move those records first.");
}

export { sendThing, sendFieldDefs, sendWriter, refuseUnsentDependents, membership as sendMembership, mayCreate as mayCreateSend, unrestrictedToken as requireSendToken };
export type { Transfer as SendTransfer };

export async function findSendArrival(targetId: string, origin: {instance: string; org: string; id: string; kind?: string}, viewer: EntityViewer) {
  let query = meta.selectFrom("share_offers").selectAll().where("target_org_id", "=", targetId)
    .where(sql<string>`(transfer->'thing'->'send'->'origin'->>'instance')`, "=", origin.instance)
    .where(sql<string>`(transfer->'thing'->'send'->'origin'->>'org')`, "=", origin.org)
    .where(sql<string>`(transfer->'thing'->'send'->'origin'->>'id')`, "=", origin.id)
    .where("status", "!=", "returned").where("status", "!=", "withdrawn");
  if (origin.kind) query = query.where(sql<string>`(transfer->'thing'->'send'->'origin'->>'kind')`, "=", origin.kind);
  const rows = await query.orderBy("created_at", "desc").execute();
  const intake = platform().scan.offerIntake();
  const alive = [];
  for (const row of rows) {
    const landed = object(row.landed);
    if (!intake || typeof landed.inbox_id !== "string") continue;
    const state = await intake.state(targetId, landed.inbox_id);
    if (state.status === "waiting" || (state.status === "filed" && state.record && await lookup(targetId, state.record.kind, state.record.id, viewer))) alive.push(row);
  }
  if (!origin.kind && new Set(alive.map((r) => (r.transfer as Transfer).thing.send?.origin.kind)).size > 1) return null;
  return alive[0] ?? null;
}
