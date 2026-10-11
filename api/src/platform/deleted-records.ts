import { handedRecord } from "./handed-record.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { canPurgeDeletedRecord, RecordRestoreRefused, platform, type DeletedRecordImage, type DeletionParticipant, type DeletionSnapshot, type EntityWriter } from "@cobblr/platform-contract";
import { runSerialised } from "./exclusive.js";
import { currentActor } from "../lib/request-context.js";
import { baseKindOf, resolveKind } from "./entities.js";
import { getHistoryWriterFor } from "./history-store.js";

export const DELETED_RECORD_DAYS = 30;
const participants = new Map<string, DeletionParticipant>();
type Lifecycle = { restore(orgId: string, id: string): Promise<void>; purge(orgId: string, id: string): Promise<boolean> };
const lifecycles = new Map<string, Lifecycle>();
interface Capture { key: string; entryId?: string; restoring?: boolean }
const captures = new AsyncLocalStorage<Capture>();
interface Kept {
  id: string; org_id: string; entity_kind: string; entity_id: string; name: string;
  instance: string | null; deleted_by: string | null; deleted_at: Date;
  image: Record<string, unknown>; details: unknown; related: { writer?: unknown; participants?: Record<string, unknown>; kind?: string }; ready: boolean; restoring: boolean;
}
const platformDb = async () => (await import("../db/meta.js")).meta as unknown as Kysely<unknown>;
const dbOf = platformDb;
const keyOf = (orgId: string, kind: string, id: string) => `${orgId}:${kind}:${id}`;
const cutoff = () => new Date(Date.now() - DELETED_RECORD_DAYS * 86_400_000);

export function registerParticipant(name: string, participant: DeletionParticipant): void { participants.set(name, participant); }
export function registerLifecycle(kind: string, lifecycle: Lifecycle): void { lifecycles.set(kind, lifecycle); }

async function locked<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T> {
  const key = keyOf(orgId, kind, id);
  if (captures.getStore()?.key === key) return work();
  return runSerialised(`deleted-record:${key}`, () => captures.run({ key }, work));
}

export async function exclusive<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T> {
  return locked(orgId, await baseKindOf(orgId, kind), id, work);
}

export async function keep(orgId: string, kind: string, id: string, image: Record<string, unknown>, details?: unknown, deletedBy?: string | null, deletedAt?: Date, related?: Kept["related"]): Promise<string> {
  kind = await baseKindOf(orgId, kind);
  const active = captures.getStore();
  const entryId = active?.key === keyOf(orgId, kind, id) ? active.entryId : undefined;
  if (entryId) {
    if (details !== undefined) await sql`update deleted_records set details = ${JSON.stringify(details)}::jsonb where id = ${entryId} and org_id = ${orgId}`.execute(await dbOf());
    return entryId;
  }
  const savedId = randomUUID();
  await sql`insert into deleted_records (id, org_id, entity_kind, entity_id, name, instance, deleted_by, image, details, related, ready, deleted_at)
    values (${savedId}, ${orgId}, ${kind}, ${id}, ${String(image.name ?? image.title ?? image.filename ?? "Untitled")},
      ${typeof image.instance === "string" ? image.instance : null}, ${deletedBy ?? currentActor()?.userId ?? null},
      ${JSON.stringify(image)}::jsonb, ${details === undefined ? null : JSON.stringify(details)}::jsonb, ${JSON.stringify(related ?? {})}::jsonb, ${active?.key !== keyOf(orgId, kind, id)}, ${deletedAt ?? new Date()})
    on conflict (org_id, entity_kind, entity_id) do update set id = excluded.id, name = excluded.name,
      instance = excluded.instance, deleted_by = excluded.deleted_by, image = excluded.image, details = excluded.details,
      related = excluded.related, restoring = false, ready = excluded.ready, deleted_at = excluded.deleted_at`.execute(await dbOf());
  if (active?.key === keyOf(orgId, kind, id)) active.entryId = savedId;
  return savedId;
}

export async function get(orgId: string, kind: string, id: string): Promise<DeletedRecordImage | null> {
  kind = await baseKindOf(orgId, kind);
  const r = (await sql<Kept>`select * from deleted_records where org_id = ${orgId} and entity_kind = ${kind} and entity_id = ${id} and deleted_at > ${cutoff()}`.execute(await dbOf())).rows[0];
  return r ? { id: r.id, image: r.image, details: r.details, deletedBy: r.deleted_by, deletedAt: r.deleted_at } : null;
}
export async function forget(orgId: string, kind: string, id: string): Promise<void> {
  kind = await baseKindOf(orgId, kind);
  if (captures.getStore()?.restoring) return;
  await sql`delete from deleted_records where org_id = ${orgId} and entity_kind = ${kind} and entity_id = ${id}`.execute(await dbOf());
}

export async function captureDelete<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<{ value: T; deletionId?: string }> {
  kind = await baseKindOf(orgId, kind);
  if (captures.getStore()?.key === keyOf(orgId, kind, id)) return { value: await work(), deletionId: captures.getStore()?.entryId };
  return locked(orgId, kind, id, async () => {
    const writer = await getHistoryWriterFor(orgId, kind);
    if (!writer) throw new Error("This record cannot yet be safely deleted.");
    const snapshot = writer.snapshotDeletion ? await writer.snapshotDeletion(orgId, id) : (() => null)();
    const image = snapshot?.image ?? await writer.snapshot(orgId, id);
    if (!image) return { value: await work() };
    const related: Kept["related"] = { writer: snapshot?.related, participants: {}, kind: typeof image.instance === "string" && image.instance !== kind.split(":")[0] ? `${image.instance}:item` : kind };
    for (const [name, participant] of participants) related.participants![name] = await participant.snapshot(orgId, { kind: related.kind!, id }, snapshot ?? { image });
    // Kept with what goes with it in one write: the row is not ready until
    // the delete is done, so nothing reads it in between.
    const deletionId = await keep(orgId, kind, id, image, undefined, undefined, undefined, related);
    try {
      const value = await work();
      const current = await writer.snapshot(orgId, id);
      if (current && !current.deleted_at) { await forget(orgId, kind, id); return { value }; }
      await sql`update deleted_records set ready = true where id = ${deletionId} and org_id = ${orgId}`.execute(await dbOf());
      return { value, deletionId };
    } catch (err) {
      const now = await writer.snapshot(orgId, id);
      if (now && !now.deleted_at) await forget(orgId, kind, id);
      else await sql`update deleted_records set ready = true where id = ${deletionId} and org_id = ${orgId}`.execute(await dbOf());
      throw err;
    }
  });
}

export async function capture<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T> {
  return (await captureDelete(orgId, kind, id, work)).value;
}

export function deletionWriter(kind: string, writer: EntityWriter): EntityWriter {
  return Object.assign(Object.create(writer) as EntityWriter, {
    delete: async (orgId: string, id: string) => { await captureDelete(orgId, kind, id, () => writer.delete(orgId, id)); },
  });
}

export class DeletedRecordError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function restore(orgId: string, kind: string, id: string, expectedId?: string): Promise<boolean> {
  kind = await baseKindOf(orgId, kind);
  return locked(orgId, kind, id, async () => {
    const sent = await handedRecord(orgId, id);
    if (sent) throw new DeletedRecordError(409, "Undo the send before restoring this record here.");
    const row = (await sql<Kept>`select * from deleted_records where org_id = ${orgId} and entity_kind = ${kind} and entity_id = ${id} and deleted_at > ${cutoff()}`.execute(await dbOf())).rows[0];
    if (!row || (expectedId && row.id !== expectedId)) return false;
    const lifecycle = lifecycles.get(kind);
    const writer = await getHistoryWriterFor(orgId, kind);
    if (!writer) throw new DeletedRecordError(409, "Enable this record's app before restoring it.");
    const current = await writer.snapshot(orgId, id);
    if (current && !current.deleted_at && !row.restoring) throw new DeletedRecordError(409, "A record already uses this id. It was left alone.");
    for (const name of Object.keys(row.related.participants ?? {})) if (!participants.has(name)) throw new DeletedRecordError(409, "Enable this record's related apps before restoring it.");
    await sql`update deleted_records set restoring = true where org_id = ${orgId} and id = ${row.id}`.execute(await dbOf());
    captures.getStore()!.restoring = true;
    if (lifecycle) { if (!current || current.deleted_at) await lifecycle.restore(orgId, id); }
    else if (writer.restoreDeletion) await writer.restoreDeletion(orgId, { image: row.image, related: row.related.writer } satisfies DeletionSnapshot);
    else if (!current || current.deleted_at) await writer.restore(orgId, row.image);
    for (const [name, image] of Object.entries(row.related.participants ?? {})) {
      const participant = participants.get(name);
      if (!participant) throw new DeletedRecordError(409, "Enable this record's related apps before restoring it.");
      await participant.restore(orgId, { kind: row.related.kind ?? kind, id }, image);
    }
    captures.getStore()!.restoring = false;
    await forget(orgId, kind, id);
    await platform().activity.log({ orgId, userId: currentActor()?.userId ?? null, action: "record_restored", ref: { module: kind.split(":")[0] ?? null, entityType: kind.split(":")[1] ?? kind, entityId: id }, diff: { name: row.name } });
    return true;
  }).catch((err: unknown) => {
    if (err instanceof RecordRestoreRefused) throw new DeletedRecordError(err.status, err.message);
    const code = (err as { code?: string }).code;
    if (code === "23503") throw new DeletedRecordError(409, "Restore this record's related records first, then try again.");
    if (code === "23505") throw new DeletedRecordError(409, "Another record uses a saved value. Resolve that conflict before restoring this record.");
    throw err;
  });
}

export async function listDeleted(orgId: string, userId: string, role: string, offset = 0, kind?: string): Promise<{ items: unknown[]; hasMore: boolean }> {
  const resolved = kind ? await resolveKind(orgId, kind) : null;
  const filter = resolved ? sql`and d.entity_kind = ${resolved.base} ${resolved.instance ? sql`and d.instance = ${resolved.instance}` : sql``}` : sql``;
  const rows = (await sql<Kept & { deleted_by_name: string | null; source: string | null }>`select d.*, u.display_name as deleted_by_name, coalesce(i.display_name, k.display_name_plural) as source from deleted_records d
    left join users u on u.id = d.deleted_by left join entity_kinds k on k.id = d.entity_kind
    left join workspace_module_instances i on i.org_id = d.org_id and i.instance_name = d.instance where d.org_id = ${orgId} and d.ready and d.deleted_at > ${cutoff()} ${filter}
    order by d.deleted_at desc, d.id limit 101 offset ${offset}`.execute(await platformDb())).rows;
  return { items: rows.slice(0, 100).map((r) => ({ id: r.id, kind: r.entity_kind, entity_id: r.entity_id, name: r.name,
    instance: r.instance, source: r.source ?? "this workspace", deleted_by: r.deleted_by_name, deleted_at: r.deleted_at,
    purge_after: new Date(new Date(r.deleted_at).getTime() + DELETED_RECORD_DAYS * 86_400_000),
    can_delete_forever: canPurgeDeletedRecord(role, r.deleted_by, userId) })), hasMore: rows.length > 100 };
}

async function purgeRelated(row: Kept): Promise<void> {
  const writer = await getHistoryWriterFor(row.org_id, row.entity_kind);
  if (!writer) return;
  const current = await writer.snapshot(row.org_id, row.entity_id);
  if (current && !current.deleted_at) return;
  for (const [name, image] of Object.entries(row.related.participants ?? {})) {
    const participant = participants.get(name);
    if (participant?.purge) await participant.purge(row.org_id, { kind: row.related.kind ?? row.entity_kind, id: row.entity_id }, image);
  }
}

async function purgeKept(row: Kept): Promise<boolean> {
  const lifecycle = lifecycles.get(row.entity_kind);
  const active = captures.getStore()!;
  active.restoring = true;
  try {
    if (lifecycle && !await lifecycle.purge(row.org_id, row.entity_id)) return false;
    await purgeRelated(row);
    await sql`delete from deleted_records where org_id = ${row.org_id} and id = ${row.id}`.execute(await dbOf());
    return true;
  } finally { active.restoring = false; }
}

export async function deleteForever(orgId: string, entryId: string, userId: string, role: string): Promise<void> {
  const row = (await sql<Kept>`select * from deleted_records where org_id = ${orgId} and id = ${entryId}`.execute(await platformDb())).rows[0];
  if (!row) throw new DeletedRecordError(404, "That record is no longer in Recently deleted.");
  if (!canPurgeDeletedRecord(role, row.deleted_by, userId)) throw new DeletedRecordError(403, "Only the person who deleted this record or a workspace admin can delete it forever.");
  await locked(orgId, row.entity_kind, row.entity_id, async () => {
    const fresh = (await sql<Kept>`select * from deleted_records where org_id = ${orgId} and id = ${entryId}`.execute(await dbOf())).rows[0];
    if (!fresh) throw new DeletedRecordError(404, "That record is no longer in Recently deleted.");
    if (!await purgeKept(fresh)) throw new DeletedRecordError(409, "This file is still used by another copy and cannot be deleted forever yet.");
  });
}

export function registerDeletedRecordsSweep(): void {
  platform().sweeps.register({ name: "platform.deleted-records", everyMs: 6 * 60 * 60 * 1000, drainMs: 60_000,
    visit: async ({ orgId, now }) => {
      const rows = (await sql<Kept>`select * from deleted_records where org_id = ${orgId}
        and (not ready or deleted_at <= ${new Date(now.getTime() - DELETED_RECORD_DAYS * 86_400_000)}) order by deleted_at limit 101`.execute(await platformDb())).rows;
      for (const row of rows.slice(0, 100)) {
        await locked(orgId, row.entity_kind, row.entity_id, async () => {
          const fresh = (await sql<Kept>`select * from deleted_records where org_id = ${orgId} and id = ${row.id}`.execute(await dbOf())).rows[0];
          if (!fresh) return;
          if (!fresh.ready) {
            const writer = await getHistoryWriterFor(orgId, fresh.entity_kind);
            if (!writer) return;
            const current = await writer.snapshot(orgId, fresh.entity_id);
            if (current && !current.deleted_at) { await forget(orgId, fresh.entity_kind, fresh.entity_id); return; }
            await sql`update deleted_records set ready = true where id = ${row.id} and org_id = ${orgId}`.execute(await dbOf());
          }
          if (new Date(fresh.deleted_at).getTime() > now.getTime() - DELETED_RECORD_DAYS * 86_400_000) return;
          await purgeKept(fresh);
        });
      }
      return { backlog: rows.length > 100 };
    },
  });
}

export async function restoreEntry(orgId: string, entryId: string): Promise<boolean> {
  const row = (await sql<Kept>`select * from deleted_records where org_id = ${orgId} and id = ${entryId}`.execute(await platformDb())).rows[0];
  return row ? restore(orgId, row.entity_kind, row.entity_id, entryId) : false;
}
