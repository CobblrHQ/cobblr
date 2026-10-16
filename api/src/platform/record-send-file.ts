import { productName } from "./product-name.js";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { platform, type DefinedField } from "@cobblr/platform-contract";
import { canUndoOwnMove, sameSendSnapshot, sendFileThing, type OfferedThing } from "@cobblr/platform-contract/share-offer";
import { readSendFile, SEND_FILE_MAX_BYTES, type SendFile } from "@cobblr/platform-contract/send-file";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { encryptCreds, decryptCreds } from "../db/crypto.js";
import { listKindsForOrg, resolveKind } from "./entities.js";
import { hiddenFieldsFor } from "./field-scope-projection.js";
import { runSerialised } from "./exclusive.js";
import { hereUrl } from "./share-links.js";
import { sendFileDigest } from "./send-file-receipt.js";
import { SendError, sendThing, sendFieldDefs, sendWriter, refuseUnsentDependents, sendMembership, requireSendToken } from "./record-send.js";

export interface ExportSendFileRequest {
  entity_kind: string; ids: string[]; mode: "copy" | "move";
  request_id?: string; include_secrets?: boolean; dry_run?: boolean;
  connected?: {link_id: string; target_org: string; target_instance: string; options_digest: string; return_receipt?: import("@cobblr/platform-contract/send-file").SendReceipt};
}
export interface FileExportTransfer {
  transport: "file-export"; state: "exported" | "landing" | "complete" | "undoing" | "undone";
  mode: "copy" | "move"; source_name: string; source_person: string; target_name?: string;
  source_changed?: boolean; source_deleted?: boolean; batch_complete?: boolean;
  source_snapshot?: Record<string, unknown>; source_attachments?: unknown;
  key_encrypted: string; digest: string; collection: SendFile["collection"]; created_at: string; ordinal: number; thing: OfferedThing;
  receipt?: import("@cobblr/platform-contract/send-file").SendReceipt;
  connected?: ExportSendFileRequest["connected"];
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as never;

export async function sendFilePerson(userId: string): Promise<string> {
  const user = await meta.selectFrom("users").select("display_name").where("id", "=", userId).executeTakeFirst();
  return user?.display_name?.trim() || "Workspace member";
}
export async function sendSourceAttachments(orgId: string, kind: string, id: string) {
  const resolved = await resolveKind(orgId, kind);
  const [module, type] = resolved.base.split(":");
  return platform().files.listAttachments(orgId, {source_module: module!, source_type: type!, source_id: id});
}
function portableField(d: DefinedField): SendFile["collection"]["fields"][number] {
  return {name: d.name, display_label: d.display_label, type: d.type, native: d.native, field_role: d.field_role, choices: d.choices, unit: d.unit, money: d.money, learns: d.learns, required: d.required, private: d.private};
}

async function prepareExport(orgId: string, userId: string, p: ExportSendFileRequest, origin?: string) {
  await requireSendToken();
  const source = await sendMembership(orgId, userId);
  if (p.mode === "move" && !roleSatisfies(source.role, ["member"])) throw new SendError("You cannot move records from this read-only workspace.");
  if (p.include_secrets) throw new SendError("Secret fields need the encrypted reveal service before they can travel.");
  const shape = (await listKindsForOrg(orgId)).find((k) => k.id === p.entity_kind);
  if (!shape) throw new SendError("That collection is not enabled here.");
  const writer = await sendWriter(orgId, p.entity_kind, userId);
  const read = writer?.snapshot ?? writer?.read;
  const canMove = canUndoOwnMove(writer) && !!read;
  if (p.mode === "move" && !canMove) throw new SendError("This collection can be copied, but cannot yet confirm a file Move safely.");
  const hidden = await hiddenFieldsFor(orgId, userId, source.role);
  const defs = (await sendFieldDefs(orgId, p.entity_kind)).filter((d) => !hidden.has(d.name) && !["secret", "computed"].includes(d.type));
  const resolved = await resolveKind(orgId, p.entity_kind);
  const collection: SendFile["collection"] = {kind: p.entity_kind, base_kind: resolved.base, module: shape.module_name, instance: resolved.instance ?? null, name: shape.display_name, plural: shape.display_name_plural || shape.display_name, fields: defs.map(portableField)};
  const instance = hereUrl(origin);
  if (!instance) throw new SendError(`This ${productName()} needs its address before it can make a send file.`);
  const entries = [];
  for (const id of p.ids) {
    if (p.mode === "move") await refuseUnsentDependents(orgId, p.entity_kind, id, userId);
    const snapshot = p.mode === "move" && read ? await read(orgId, id) : null;
    const attachments = p.mode === "move" ? await sendSourceAttachments(orgId, p.entity_kind, id) : null;
    const thing = await sendThing(orgId, userId, p.entity_kind, id, {userId, role: source.role}, false);
    thing.send!.mode = p.mode;
    thing.send!.origin.instance = instance;
    if (p.mode === "move" && (!snapshot || !sameSendSnapshot(snapshot, await read!(orgId, id)) || !sameSendSnapshot(attachments, await sendSourceAttachments(orgId, p.entity_kind, id)))) throw new SendError("An item changed while its file was being prepared. Download it again with the current details.");
    entries.push({thing: sendFileThing(thing), snapshot, attachments});
  }
  return {source, collection, entries, canMove, person: await sendFilePerson(userId)};
}

export async function previewConnectedPacket(orgId: string, userId: string, p: ExportSendFileRequest, origin?: string) {
  const plan = await prepareExport(orgId, userId, p, origin);
  return packetFor(plan, orgId, p.mode, randomUUID(), randomBytes(32).toString("hex"), new Date().toISOString());
}

function packetFor(plan: Awaited<ReturnType<typeof prepareExport>>, orgId: string, mode: "copy" | "move", id: string, key: string, createdAt: string) {
  const packet = readSendFile(json({format: "cobblr-send", version: 1, id, created_at: createdAt, mode, confirmation_key: key, source: {instance: plan.entries[0]!.thing.send!.origin.instance, org: orgId, name: plan.source.name, person: plan.person}, collection: plan.collection, items: plan.entries.map((e) => e.thing)}));
  if (Buffer.byteLength(JSON.stringify(packet)) > SEND_FILE_MAX_BYTES) throw new SendError("This send file is over 64 MB. Send fewer items together; every file on those items stays included.");
  return packet;
}

export async function previewExportSendFile(orgId: string, userId: string, p: ExportSendFileRequest, origin?: string) {
  const plan = await prepareExport(orgId, userId, p, origin);
  return {can_move: plan.canMove, collection: plan.collection.plural, items: plan.entries.map(({thing}) => ({id: thing.send!.origin.id, name: thing.name, fields: Object.keys(thing.send!.values), files: thing.send!.files.length, dropped: [...thing.send!.needs, ...(thing.send!.references ?? []).map((r) => `${r.label}: kept only if its linked record exists there`)], placement_needed: !!thing.send!.placement_needed})), summary: "The source stays here. Choose the receiving collection and map fields when you import the file."};
}

export async function fileExportRows(orgId: string, userId: string, id: string) {
  return meta.selectFrom("share_offers").selectAll().where("batch", "=", id).where("created_by", "=", userId)
    .where(sql<string>`(source->>'org_id')`, "=", orgId).where(sql<string>`(transfer->>'transport')`, "=", "file-export").orderBy("created_at").orderBy("id").execute();
}
export async function exportSendFile(orgId: string, userId: string, p: ExportSendFileRequest, origin?: string) {
  if (p.dry_run) return previewExportSendFile(orgId, userId, p, origin);
  return runSerialised(`record-send:${orgId}`, async () => {
    await requireSendToken();
    const source = await sendMembership(orgId, userId);
    if (p.mode === "move" && !roleSatisfies(source.role, ["member"])) throw new SendError("You cannot move records from this read-only workspace.");
    const id = p.request_id ?? randomUUID();
    const existing = await fileExportRows(orgId, userId, id);
    if (existing.length) {
      if (!sameSendSnapshot((existing[0]!.transfer as FileExportTransfer).connected, p.connected)) throw new SendError("That request belongs to a different destination or mapping. Preview a new send.");
      if (existing.length !== p.ids.length || existing.some((r) => object(r.source).kind !== p.entity_kind || !p.ids.includes(String(object(r.source).id)) || object(r.transfer).mode !== p.mode || object(r.transfer).state === "undone")) throw new SendError("That file request belongs to a different send. Preview and download a new file.");
      return {id, download_path: `/api/v1/orgs/${source.slug}/records/send/file/${id}/download`, summary: `${p.ids.length} ${p.ids.length === 1 ? "item" : "items"} ready to download. The source is still here.`};
    }
    const plan = await prepareExport(orgId, userId, p, origin);
    const createdAt = new Date().toISOString();
    const key = randomBytes(32).toString("hex");
    const packet = packetFor(plan, orgId, p.mode, id, key, createdAt);
    const digest = sendFileDigest(packet);
    const encrypted = encryptCreds(key);
    const rows = plan.entries.map(({thing, snapshot, attachments}, ordinal) => ({link_id: null, target_org_id: null, direction: "out" as const, batch: id, title: thing.name, created_by: userId, source: json({org_id: orgId, kind: p.entity_kind, id: thing.send!.origin.id}), transfer: json({transport: "file-export", state: "exported", mode: p.mode, source_name: plan.source.name, source_person: plan.person, key_encrypted: encrypted, digest, collection: plan.collection, created_at: createdAt, ordinal, thing, ...(p.connected ? {connected: p.connected} : {}), ...(snapshot ? {source_snapshot: snapshot, source_attachments: attachments} : {})} satisfies FileExportTransfer)}));
    await meta.insertInto("share_offers").values(rows).execute();
    await platform().activity.log({orgId, userId, action: "send_file_downloaded", diff: {items: rows.length, mode: p.mode}, ref: {module: "platform", entityType: "send", entityId: id}});
    return {id, download_path: `/api/v1/orgs/${source.slug}/records/send/file/${id}/download`, summary: `${rows.length} ${rows.length === 1 ? "item" : "items"} ready to download. The source is still here.`};
  });
}

export async function downloadSendFile(orgId: string, userId: string, id: string): Promise<SendFile> {
  await requireSendToken();
  await sendMembership(orgId, userId);
  const rows = await fileExportRows(orgId, userId, id);
  if (!rows.length) throw new SendError("That is not a send file you made here.");
  const first = rows[0]!.transfer as FileExportTransfer;
  rows.sort((a, b) => (a.transfer as FileExportTransfer).ordinal - (b.transfer as FileExportTransfer).ordinal);
  return readSendFile({format: "cobblr-send", version: 1, id, created_at: first.created_at, mode: first.mode, confirmation_key: decryptCreds(first.key_encrypted), source: {instance: first.thing.send!.origin.instance, org: orgId, name: first.source_name, person: first.source_person}, collection: first.collection, items: rows.map((r) => sendFileThing((r.transfer as FileExportTransfer).thing))});
}
