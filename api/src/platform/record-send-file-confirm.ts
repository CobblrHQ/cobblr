import { productName } from "./product-name.js";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sameSendSnapshot } from "@cobblr/platform-contract/share-offer";
import { SendReceiptSchema } from "@cobblr/platform-contract/send-file";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { decryptCreds } from "../db/crypto.js";
import { runSerialised } from "./exclusive.js";
import { markGone, bringBack } from "./dispositions.js";
import { get as getDeleted, restore as restoreDeleted } from "./deleted-records.js";
import { SendError, sendMembership, requireSendToken, sendWriter, refuseUnsentDependents } from "./record-send.js";
import { fileExportRows, sendSourceAttachments, type FileExportTransfer } from "./record-send-file.js";
import { verifySendReceipt } from "./send-file-receipt.js";

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as never;
async function save(id: string, t: FileExportTransfer, returned = false) {
  await meta.updateTable("share_offers").set({transfer: json(t), ...(returned ? {status: "returned", decided_at: new Date()} : t.state === "complete" ? {status: "taken", taken_at: new Date(), decided_at: new Date()} : {})}).where("id", "=", id).execute();
}
async function confirmation(orgId: string, userId: string, input: unknown, phase: "imported" | "undone") {
  await requireSendToken();
  const source = await sendMembership(orgId,userId);
  const parsed = SendReceiptSchema.safeParse(input);
  if (!parsed.success) throw new SendError(`This confirmation file cannot be read. Download it again from the receiving ${productName()}.`);
  const receipt = parsed.data;
  const rows = await fileExportRows(orgId,userId,receipt.file_id);
  if (!rows.length) throw new SendError("This confirmation does not belong to a send file you made here.");
  const t = rows[0]!.transfer as FileExportTransfer;
  const prior = t.receipt;
  if (t.connected && (receipt.target.org !== t.connected.target_org || receipt.target.instance !== t.connected.target_instance)) throw new SendError("This confirmation is from a different connected workspace. The source was left alone.");
  if (phase === "undone" && !prior) throw new SendError("This Move has not been confirmed here. Its source is still here.");
  if (!verifySendReceipt(receipt,decryptCreds(t.key_encrypted),{file_id: receipt.file_id,digest: t.digest,source_instance: t.thing.send!.origin.instance,source_org: orgId,ids: rows.map((r) => (r.transfer as FileExportTransfer).thing.send!.origin.id),phase,...(prior ? {target: {instance: prior.target.instance,org: prior.target.org,import_id: prior.import_id}} : {})})) throw new SendError("This confirmation is incomplete or belongs to another send. The source was left alone.");
  if (t.mode === "move" && !roleSatisfies(source.role,["member"])) throw new SendError("You cannot change records in this read-only source workspace.");
  return {source,rows,receipt};
}

async function restoreRows(orgId: string, userId: string, rows: Awaited<ReturnType<typeof fileExportRows>>) {
  for (const row of rows) {
    const t = row.transfer as FileExportTransfer;
    if (!t.source_changed) continue;
    const origin = t.thing.send!.origin;
    const writer = await sendWriter(orgId,origin.kind,userId);
    if (!writer) throw new SendError("Enable the source collection to restore these items.");
    const current = await (writer.snapshot ?? writer.read)?.(orgId,origin.id);
    if ((!current || current.deleted_at) && !await getDeleted(orgId,origin.kind,origin.id)) throw new SendError("The source restore is no longer available. Its saved history has expired.");
  }
  for (const row of rows) {
    const t = row.transfer as FileExportTransfer;
    t.state = "undoing";
    await save(row.id,t,true);
    if (t.source_changed) {
      const origin = t.thing.send!.origin;
      const writer = await sendWriter(orgId,origin.kind,userId);
      const current = await (writer?.snapshot ?? writer?.read)?.(orgId,origin.id);
      if ((!current || current.deleted_at) && !await restoreDeleted(orgId,origin.kind,origin.id)) throw new SendError("The source restore is no longer available.");
      if (!t.source_deleted) {
        const restored = await bringBack(orgId,userId,origin.kind,[origin.id]);
        if (!restored.ok) throw new SendError(restored.error);
      }
    }
    t.state = "undone";
    await save(row.id,t,true);
  }
}

export async function confirmSendFile(orgId: string, userId: string, input: unknown, dryRun = false) {
  return runSerialised(`record-send:${orgId}`,async () => {
    const {rows,receipt} = await confirmation(orgId,userId,input,"imported");
    if (rows.every((r) => (r.transfer as FileExportTransfer).state === "complete")) return {ok: true, summary: "This import was already confirmed here."};
    if (rows.some((r) => (r.transfer as FileExportTransfer).state !== "exported")) throw new SendError("This send is being recovered or was restored. Download a new file for another send.");
    for (const row of rows) {
      const t = row.transfer as FileExportTransfer;
      if (t.mode !== "move") continue;
      const origin = t.thing.send!.origin;
      const writer = await sendWriter(orgId,origin.kind,userId);
      const read = writer?.snapshot ?? writer?.read;
      if (!read || !sameSendSnapshot(t.source_snapshot,await read(orgId,origin.id)) || !sameSendSnapshot(t.source_attachments,await sendSourceAttachments(orgId,origin.kind,origin.id))) throw new SendError("A source item changed since the download. Keep those changes and download a new send file.");
      await refuseUnsentDependents(orgId,origin.kind,origin.id,userId);
    }
    if (dryRun) return {items: rows.length, mode: (rows[0]!.transfer as FileExportTransfer).mode, target: receipt.target, summary: `Confirm the import into ${receipt.target.name}. A Move removes the unchanged source only after this confirmation.`};
    for (const row of rows) {
      const t = row.transfer as FileExportTransfer;
      t.receipt = receipt; t.target_name = receipt.target.name; t.state = "landing";
      await save(row.id,t);
    }
    try {
      for (const row of rows) {
        const t = row.transfer as FileExportTransfer;
        if (t.mode === "move") {
          const origin = t.thing.send!.origin;
          const writer = await sendWriter(orgId,origin.kind,userId);
          if (!writer) throw new SendError("The source collection is no longer enabled.");
          t.source_changed = true;
          t.source_deleted = !(writer.retire && writer.unretire);
          await save(row.id,t);
          if (t.source_deleted) await writer.delete(orgId,origin.id);
          else {
            const moved = await markGone(orgId,userId,origin.kind,[origin.id],{how: "given-away",to: receipt.target.name,note: `Sent to another ${productName()}`});
            if (!moved.ok) throw new SendError(moved.error);
          }
        }
        t.state = "complete";
        await save(row.id,t);
      }
      for (const row of rows) {const t = row.transfer as FileExportTransfer; t.batch_complete = true; await save(row.id,t);}
    } catch (err) {await restoreRows(orgId,userId,rows); throw err;}
    await platform().activity.log({orgId,userId,action: "send_file_confirmed",diff: {items: rows.length,to: receipt.target.instance,person: receipt.target.person},ref: {module: "platform",entityType: "send",entityId: receipt.file_id}});
    return {ok: true,summary: `${rows.length} ${rows.length === 1 ? "item" : "items"} confirmed in ${receipt.target.name}. ${(rows[0]!.transfer as FileExportTransfer).mode === "move" ? "The source has moved." : "The source stays here."}`};
  });
}

export async function restoreSendFileSource(orgId: string, userId: string, input: unknown, dryRun = false) {
  return runSerialised(`record-send:${orgId}`,async () => {
    const {rows,receipt} = await confirmation(orgId,userId,input,"undone");
    if ((rows[0]!.transfer as FileExportTransfer).mode !== "move") throw new SendError("This was a Copy. Its source stayed here.");
    if (rows.every((r) => (r.transfer as FileExportTransfer).state === "undone")) return {ok: true,summary: "The source was already restored here."};
    if (dryRun) return {items: rows.length, target: receipt.target, summary: `Restore ${rows.length} source ${rows.length === 1 ? "item" : "items"} here. Their import was undone in ${receipt.target.name}.`};
    await restoreRows(orgId,userId,rows);
    return {ok: true,summary: `${rows.length} source ${rows.length === 1 ? "item" : "items"} restored here.`};
  });
}

export function registerSendFileSourceRecovery(): void {
  platform().sweeps.register({
    name: "platform.send-file-source-recovery", everyMs: 60_000,
    async candidates() {
      const rows = await meta.selectFrom("share_offers").select(sql<string>`source->>'org_id'`.as("org_id")).where(sql<string>`(transfer->>'transport')`,"=","file-export").where(sql<boolean>`(transfer->>'state' in ('landing','undoing') or (transfer->>'state' = 'complete' and transfer->>'batch_complete' is distinct from 'true'))`).execute();
      return [...new Set(rows.map((r) => r.org_id))];
    },
    async visit({orgId}) {
      const rows = await meta.selectFrom("share_offers").select(["batch","created_by"]).where(sql<string>`(source->>'org_id')`,"=",orgId).where(sql<string>`(transfer->>'transport')`,"=","file-export").where(sql<boolean>`(transfer->>'state' in ('landing','undoing') or (transfer->>'state' = 'complete' and transfer->>'batch_complete' is distinct from 'true'))`).where("created_at","<",new Date(Date.now() - 5 * 60_000)).execute();
      const visited = new Set<string>();
      for (const row of rows) if (row.batch && row.created_by && !visited.has(row.batch)) {
        visited.add(row.batch);
        await runSerialised(`record-send:${orgId}`,async () => {
          const batch = await fileExportRows(orgId,row.created_by!,row.batch!);
          if (batch.some((r) => {const t = r.transfer as FileExportTransfer; return t.state !== "exported" && t.state !== "undone" && !(t.state === "complete" && t.batch_complete);})) await restoreRows(orgId,row.created_by!,batch);
        });
      }
    },
  });
}
