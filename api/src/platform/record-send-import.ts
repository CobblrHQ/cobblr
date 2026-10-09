import { createHash } from "node:crypto";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SendReceipt } from "@cobblr/platform-contract/send-file";
import { meta } from "../db/meta.js";
import { encryptCreds, decryptCreds } from "../db/crypto.js";
import { runSerialised } from "./exclusive.js";
import { hereUrl } from "./share-links.js";
import { sendFilePerson } from "./record-send-file.js";
import { sendFileDigest, signSendReceipt } from "./send-file-receipt.js";
import { prepareSendFileImport, prepareImportedCollection, previewSendFileImport, type IncomingSendFileRequest } from "./record-send-import-plan.js";
import { SendError, sendMembership, requireSendToken, sendWriter, sendFieldDefs, undoFileArrival, type SendTransfer } from "./record-send.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as never;
type ImportTransfer = SendTransfer & {transport: "file-import"; file_id: string; file_digest: string; key_encrypted: string; target_instance?: string; ordinal: number};
function importId(orgId: string, userId: string, request: string): string {
  const h = createHash("sha256").update(JSON.stringify([orgId, userId, request])).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
async function rowsForImport(orgId: string, userId: string, id: string) {
  return meta.selectFrom("share_offers").selectAll().where("batch", "=", id).where("target_org_id", "=", orgId).where("created_by", "=", userId).where(sql<string>`transfer->>'transport'`, "=", "file-import").execute();
}
async function saveImport(id: string, t: ImportTransfer, landed?: unknown) {
  await meta.updateTable("share_offers").set({transfer: json(t), ...(landed ? {landed: json(landed)} : {}), ...(t.state === "complete" ? {status: "taken", taken_at: new Date(), decided_at: new Date()} : {})}).where("id", "=", id).execute();
}
export async function receiptForImport(orgId: string, userId: string, id: string, phase: "imported" | "undone"): Promise<SendReceipt> {
  const rows = await rowsForImport(orgId, userId, id);
  if (!rows.length) throw new SendError("That is not a file import you made here.");
  if (rows.some((r) => {const t = r.transfer as ImportTransfer; return phase === "imported" ? t.state !== "complete" || !t.batch_complete : t.state !== "undone";})) throw new SendError("Finish the import or its Undo before downloading this confirmation.");
  rows.sort((a,b) => (a.transfer as ImportTransfer).ordinal - (b.transfer as ImportTransfer).ordinal);
  const t = rows[0]!.transfer as ImportTransfer;
  const origin = t.thing.send!.origin;
  const target = await sendMembership(orgId, userId);
  return signSendReceipt({format: "cobblr-send-receipt", version: 1, file_id: t.file_id, digest: t.file_digest, source_instance: origin.instance, source_org: origin.org, import_id: id, target: {instance: t.target_instance || hereUrl(), org: orgId, name: target.name, person: await sendFilePerson(userId)}, ids: rows.map((r) => (r.transfer as ImportTransfer).thing.send!.origin.id), phase}, decryptCreds(t.key_encrypted));
}

export async function importSendFile(orgId: string, userId: string, p: IncomingSendFileRequest, origin?: string) {
  if (p.dry_run) return previewSendFileImport(orgId, userId, p);
  return runSerialised(`record-send:${orgId}`, async () => {
    const first = await prepareSendFileImport(orgId, userId, p);
    const id = importId(orgId, userId, p.request_id ?? p.packet.id);
    const digest = sendFileDigest(p.packet);
    const existing = await rowsForImport(orgId, userId, id);
    if (existing.length) {
      if (existing.length !== p.packet.items.length || existing.some((r) => (r.transfer as ImportTransfer).file_digest !== digest)) throw new SendError("That import request belongs to a different file.");
      if (existing.some((r) => object(r.transfer).state === "undone")) throw new SendError("This import was undone. Preview it again and choose a new import request.");
      if (existing.every((r) => object(r.transfer).state === "complete" && object(r.transfer).batch_complete)) return {import_id: id, sent: existing.length, receipt: await receiptForImport(orgId, userId, id, "imported"), summary: "This file was already imported."};
      throw new SendError("The earlier import is being recovered. Wait for it to finish before importing again.");
    }
    if (first.blocked.length) throw new SendError(first.blocked.join(" "));
    await prepareImportedCollection(orgId, userId, p);
    const plan = await prepareSendFileImport(orgId, userId, {...p, create_matching: false, add_fields: []});
    if (plan.blocked.length) throw new SendError(plan.blocked.join(" "));
    if (plan.things.some((i) => i.preview.duplicate) && !p.duplicate) throw new SendError("These records were sent before. Update the earlier copy or make another.");
    const intake = platform().scan.offerIntake();
    if (!intake?.file) throw new SendError("Enable the scan inbox to receive this file.");
    const targetInstance = hereUrl(origin);
    if (!targetInstance) throw new SendError("This Cobblr needs its address before it can make an import confirmation.");
    const made: string[] = [];
    try {
      for (const [ordinal, {thing, preview}] of plan.things.entries()) {
        const t: ImportTransfer = {transport: "file-import", target_instance: targetInstance, file_id: p.packet.id, file_digest: digest, key_encrypted: encryptCreds(p.packet.confirmation_key), ordinal, mode: p.packet.mode, state: "landing", target_name: plan.target.name, source_name: `${p.packet.source.name} (${p.packet.source.instance}), ${p.packet.source.person}`, thing};
        const row = await meta.insertInto("share_offers").values({link_id: null, target_org_id: orgId, direction: "in", batch: id, title: thing.name, created_by: userId, source: json({org_id: p.packet.source.org, kind: p.packet.collection.kind, id: preview.id}), transfer: json(t)}).onConflict((oc) => oc.expression(sql`batch, (source->>'id')`).where("target_org_id","is not",null).doUpdateSet({batch: id})).returningAll().executeTakeFirstOrThrow();
        made.push(row.id);
        const [arrival] = await intake.receive(orgId, {own: true, session: {key: `send-file:${id}`, label: `Sent from ${t.source_name}`, from: t.source_name}, things: [{offer_id: row.id, thing}], acquiredFrom: t.source_name, acquiredOn: await platform().accounts.dayFor(userId), as: {userId, orgSlug: plan.target.slug}});
        if (!arrival) throw new SendError("The item did not arrive. The source is still on the sending Cobblr.");
        const landed = {org_id: orgId, inbox_id: arrival.inbox_id};
        t.state = "landed";
        await saveImport(row.id, t, landed);
        if (preview.duplicate && p.duplicate === "update") {
          const previous = await meta.selectFrom("share_offers").select("landed").where("id", "=", preview.duplicate).executeTakeFirstOrThrow();
          const earlier = object(previous.landed);
          const state = typeof earlier.inbox_id === "string" ? await intake.state(orgId, earlier.inbox_id) : null;
          if (state?.status !== "filed" || !state.record) throw new SendError("File the earlier copy before updating it, or make another copy.");
          if (state.record.kind !== thing.send!.target_kind || preview.arrival !== "collection") throw new SendError("Choose the earlier copy's collection and resolve every field before updating it.");
          const writer = await sendWriter(orgId, state.record.kind, userId);
          const read = writer?.snapshot ?? writer?.read;
          if (!writer || !read || !intake.retarget) throw new SendError("This collection cannot undo an update safely. Make another copy instead.");
          t.previous = await read(orgId, state.record.id) ?? undefined;
          if (!t.previous) throw new SendError("The earlier copy no longer exists.");
          t.previous_id = state.record.id; t.previous_kind = state.record.kind;
          await saveImport(row.id, t, landed);
          const fields = {...thing.send!.mapped};
          const metadata = {...object(t.previous.metadata)};
          for (const d of await sendFieldDefs(orgId, state.record.kind)) if (!d.native && Object.hasOwn(fields,d.name)) {metadata[d.name] = fields[d.name]; delete fields[d.name];}
          await writer.update(orgId, state.record.id, {...fields, metadata});
          t.added_attachments = await intake.retarget(orgId, arrival.inbox_id, state.record);
          t.target_record = state.record;
          t.target_after = await read(orgId, state.record.id) ?? undefined;
        } else if (preview.arrival === "collection") {
          t.target_record = await intake.file(orgId, arrival.inbox_id, {userId, orgSlug: plan.target.slug});
          const writer = await sendWriter(orgId, t.target_record.kind, userId);
          t.target_after = await writer?.snapshot?.(orgId, t.target_record.id) ?? undefined;
          t.target_related = (await writer?.snapshotDeletion?.(orgId, t.target_record.id))?.related;
        }
        t.state = "complete";
        await saveImport(row.id, t, landed);
      }
    } catch (err) {
      for (const offerId of made.reverse()) await undoFileArrival(orgId, userId, offerId, false, true);
      throw err;
    }
    await meta.updateTable("share_offers").set({transfer: sql`transfer || '{"batch_complete":true}'::jsonb` as never}).where("batch", "=", id).where("target_org_id", "=", orgId).execute();
    await platform().activity.log({orgId,userId,action: "send_file_imported",diff: {items: made.length, from: p.packet.source.instance, person: p.packet.source.person},ref: {module: "platform",entityType: "send",entityId: id}});
    return {import_id: id, sent: made.length, offer_ids: made, items: plan.things.map((i) => i.preview), receipt: await receiptForImport(orgId,userId,id,"imported"), summary: `${made.length} ${made.length === 1 ? "item" : "items"} imported. The source stays on the sending Cobblr until a Move is confirmed there.`};
  });
}

export async function undoSendFileImport(orgId: string, userId: string, id: string, dryRun = false) {
  return runSerialised(`record-send:${orgId}`, async () => {
    await requireSendToken();
    await sendMembership(orgId,userId);
    const rows = await rowsForImport(orgId,userId,id);
    if (!rows.length) throw new SendError("That is not a file import you made here.");
    for (const row of rows) await undoFileArrival(orgId,userId,row.id,true,true);
    if (dryRun) return {summary: `Undo ${rows.length} imported items here. The source on the sending Cobblr stays as it is.`};
    for (const row of rows.reverse()) await undoFileArrival(orgId,userId,row.id,false,true);
    return {ok: true, receipt: await receiptForImport(orgId,userId,id,"undone"), summary: "Import undone here. For a Move, take this return file to the source Cobblr to restore the source separately."};
  });
}
