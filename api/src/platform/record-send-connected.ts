import { productName } from "./product-name.js";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { canonicalJson } from "@cobblr/platform-contract/service-consent";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { SendFileSchema, SendReceiptSchema, type SendReceipt } from "@cobblr/platform-contract/send-file";
import { meta } from "../db/meta.js";
import { decryptCreds } from "../db/crypto.js";
import { list, listKindsForOrg } from "./entities.js";
import { hereUrl } from "./share-links.js";
import { getShareLink, isOwnLink, signedPeerPost, ShareDeliveryError, type ShareLinkRow } from "./share-sync.js";
import { SendError, sendMembership, requireSendToken, mayCreateSend, type SendRequest, type SendPreview } from "./record-send.js";
import { exportSendFile, downloadSendFile, fileExportRows, previewConnectedPacket, type FileExportTransfer } from "./record-send-file.js";
import { confirmSendFile, restoreSendFileSource } from "./record-send-file-confirm.js";
import { importSendFile, undoSendFileImport } from "./record-send-import.js";
import { verifySendReceipt } from "./send-file-receipt.js";
import { runSerialised } from "./exclusive.js";

const settings = (link: ShareLinkRow) => (link.settings ?? {}) as {peer_org_id?: string};
const RpcBody = z.discriminatedUnion("act", [
  z.object({act: z.literal("options")}),
  z.object({act: z.literal("import"), packet: SendFileSchema, dry_run: z.boolean().optional(), request_id: z.string().uuid().optional(), collection: z.string().max(120).nullable().optional(), field_map: z.record(z.string().nullable()).optional(), create_matching: z.boolean().optional(), add_fields: z.array(z.string().max(120)).max(100).optional(), placement: z.literal("unplaced").optional(), location: z.string().uuid().nullable().optional(), duplicate: z.enum(["update", "another"]).optional()}),
  z.object({act: z.literal("undo"), import_id: z.string().uuid()}),
]);
type PeerOptions = {id: string; slug: string; name: string; role: string; collections: Array<{kind: string; label: string; module: string}>; places: Array<{id: string; title: string}>};

async function approved(link: ShareLinkRow) {
  if (!isOwnLink(link) || link.status !== "active" || !link.created_by || !settings(link).peer_org_id) throw new SendError("This workspace connection is not active. Connect it again, or use a send file.");
  return sendMembership(link.org_id, link.created_by);
}

export async function receiveConnectedSend(link: ShareLinkRow, input: unknown, origin?: string): Promise<unknown> {
  const local = await approved(link);
  const body = RpcBody.parse(input);
  const peerOrigin = link.peer_url || hereUrl(origin);
  if (body.act === "options") {
    if (!roleSatisfies(local.role, ["member"])) throw new SendError("The approving account can no longer create records in this workspace.");
    const collections = [];
    for (const k of await listKindsForOrg(local.id)) if (await mayCreateSend(local.id, link.created_by!, local.role, k.module_name)) collections.push({kind: k.id, label: k.display_name_plural || k.display_name, module: k.module_name});
    const places = await list(local.id, "core-locations:location", {limit: 500}, {userId: link.created_by!, role: local.role});
    return {...local, collections, places: places.items.map((p) => ({id: p.id, title: p.title}))};
  }
  if (body.act === "import") {
    if (body.packet.source.org !== settings(link).peer_org_id || body.packet.source.instance !== peerOrigin) throw new SendError("This send is not from the workspace that approved this connection.");
    return importSendFile(link.org_id, link.created_by!, body, origin);
  }
  const rows = await meta.selectFrom("share_offers").select("transfer").where("batch", "=", body.import_id).where("target_org_id", "=", link.org_id).where("created_by", "=", link.created_by!).execute();
  if (!rows.length || rows.some((r) => {const t = r.transfer as {thing?: {send?: {origin?: {org: string; instance: string}}}};return t.thing?.send?.origin?.org !== settings(link).peer_org_id || t.thing?.send?.origin?.instance !== peerOrigin;})) throw new SendError("That import does not belong to this connection.");
  return undoSendFileImport(link.org_id, link.created_by!, body.import_id);
}

async function callPeer<T>(link: ShareLinkRow, body: unknown): Promise<T> {
  try {
    if (!link.peer_link_id) throw new SendError("This connection is not paired yet.");
    if (!link.peer_url) {
      const peer = await getShareLink(link.peer_link_id);
      if (!peer) throw new SendError("The other workspace has ended this connection.");
      return await receiveConnectedSend(peer, body, hereUrl()) as T;
    }
    const res = await signedPeerPost(link, `/api/v1/share-links/${link.peer_link_id}/own-send`, body);
    if (!res.ok) {
      const said = await res.json().catch(() => null) as {error?: {message?: string}} | null;
      throw new SendError(res.status === 404 ? `The other ${productName()} needs updating for connected sends. Use a send file instead.` : said?.error?.message || `The other ${productName()} did not complete this send. The source stays here until confirmation.`);
    }
    return await res.json() as T;
  } catch (e) {if (e instanceof ShareDeliveryError) throw new SendError(`${e.message}. The source stays here until the import is confirmed. Retry this same send to recover its answer.`);throw e;}
}

export async function ownConnections(orgId: string, userId: string) {
  await requireSendToken();
  await sendMembership(orgId, userId);
  return meta.selectFrom("share_links").select(["id", "status", "peer_url", "peer_workspace_name", "created_at"])
    .where("org_id", "=", orgId).where("created_by", "=", userId).where("status", "!=", "revoked").where(sql<boolean>`settings->>'purpose' = 'own'`).orderBy("created_at", "desc").execute();
}

export async function connectedTargets(orgId: string, userId: string) {
  const targets = [];
  const refused: string[] = [];
  for (const row of await ownConnections(orgId, userId)) {
    if (row.status !== "active") continue;
    const link = await getShareLink(row.id);
    if (!link) continue;
    try {const remote = await callPeer<PeerOptions>(link, {act: "options"});if (remote.id !== settings(link).peer_org_id) throw new SendError("The connection answered for a different workspace.");targets.push({...remote, connection_id: link.id, host: link.peer_url ? new URL(link.peer_url).host : null});}
    catch (e) {if (!(e instanceof SendError)) throw e; refused.push(`${row.peer_workspace_name || "Connected workspace"}: ${e.message}`);}
  }
  return {targets, refused};
}

async function sourceLink(orgId: string, userId: string, id: string, targetOrg?: string) {
  await requireSendToken();
  await sendMembership(orgId, userId);
  const link = await getShareLink(id);
  if (!link || link.org_id !== orgId || link.created_by !== userId || (targetOrg && targetOrg !== settings(link).peer_org_id)) throw new SendError("Choose a connection you approved from this workspace.");
  await approved(link);
  return link;
}

function options(p: SendRequest) {
  return {collection: p.collection ?? null, field_map: p.field_map ?? {}, create_matching: p.create_matching ?? false, add_fields: p.add_fields ?? [], placement: p.placement, location: p.location ?? null, duplicate: p.duplicate};
}

export async function previewConnectedSend(orgId: string, userId: string, p: SendRequest): Promise<SendPreview> {
  const link = await sourceLink(orgId, userId, p.connection_id!, p.target_org);
  const packet = await previewConnectedPacket(orgId, userId, p);
  return callPeer<SendPreview>(link, {act: "import", packet, ...options(p), dry_run: true});
}

export async function sendConnectedRecords(orgId: string, userId: string, p: SendRequest) {
  return runSerialised(`record-connected:${orgId}`, async () => {
    const link = await sourceLink(orgId, userId, p.connection_id!, p.target_org);
    const id = p.request_id || randomUUID();
    const connected = {link_id: link.id, target_org: p.target_org, target_instance: link.peer_url || hereUrl(), options_digest: createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(options(p))))).digest("hex")};
    await exportSendFile(orgId, userId, {...p, request_id: id, connected});
    const packet = await downloadSendFile(orgId, userId, id);
    const received = await callPeer<{receipt: SendReceipt; sent: number}>(link, {act: "import", packet, ...options(p), request_id: id});
    const receipt = SendReceiptSchema.parse(received.receipt);
    if (receipt.target.org !== connected.target_org || receipt.target.instance !== connected.target_instance) throw new SendError("The confirmation is from a different workspace. The source was left alone.");
    const confirmed = await confirmSendFile(orgId, userId, receipt);
    return {summary: confirmed.summary, offer_ids: [id], connected: true};
  });
}

export async function undoConnectedSend(orgId: string, userId: string, id: string, restore = false) {
  const rows = await fileExportRows(orgId, userId, id);
  const t = rows[0]?.transfer as FileExportTransfer | undefined;
  if (!t?.connected) return null;
  return runSerialised(`record-connected:${orgId}`, async () => {
    await requireSendToken();
    await sendMembership(orgId, userId);
    if (restore) {
      if (!t.connected!.return_receipt) throw new SendError("Undo the import there before restoring the source here.");
      return restoreSendFileSource(orgId, userId, t.connected!.return_receipt);
    }
    if (!t.receipt) throw new SendError("Retry the same send to recover its import confirmation before Undo.");
    if (!t.connected!.return_receipt) {
      const link = await sourceLink(orgId, userId, t.connected!.link_id);
      const undone = await callPeer<{receipt: SendReceipt}>(link, {act: "undo", import_id: t.receipt.import_id});
      const returned = SendReceiptSchema.parse(undone.receipt);
      if (!verifySendReceipt(returned, decryptCreds(t.key_encrypted), {file_id: id, digest: t.digest, source_instance: t.thing.send!.origin.instance, source_org: orgId, ids: rows.map((r) => (r.transfer as FileExportTransfer).thing.send!.origin.id), phase: "undone", target: {instance: t.receipt.target.instance, org: t.receipt.target.org, import_id: t.receipt.import_id}})) throw new SendError("The return confirmation does not belong to this send.");
      await meta.updateTable("share_offers").set({transfer: sql`jsonb_set(transfer, '{connected,return_receipt}', ${JSON.stringify(returned)}::jsonb)` as never}).where("batch", "=", id).where("created_by", "=", userId).where(sql<string>`(source->>'org_id')`, "=", orgId).execute();
    }
    return {summary: t.mode === "move" ? "Import undone there. Restore the source here as a separate step." : "Copy removed there. The source stayed here.", restore_available: t.mode === "move"};
  });
}
