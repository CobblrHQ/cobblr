import type { EntityWriter } from "@cobblr/platform-contract";
import { currentHistoryWrite, historyDiff, runHistoryWrite, type HistoryWrite } from "./record-history.js";

export async function finishHistoryWrite(write: HistoryWrite): Promise<void> {
  if (write.logged) return;
  const after = await write.readAfter();
  if (!after) return;
  const diff = historyDiff(write.before, after);
  if (!(diff.changes as unknown[]).length && !write.forceLog) return;
  const { log } = await import("./activity.js");
  const [module, entityType] = write.kind.split(":");
  await log({ orgId: write.orgId, action: `${entityType}_updated`, ref: { module: module ?? null, entityType: entityType ?? write.kind, entityId: write.id }, before: write.before, diff });
  write.logged = true;
}

export function historyWriter(kind: string, writer: EntityWriter): EntityWriter {
  const read = writer.snapshot?.bind(writer) ?? writer.read?.bind(writer);
  if (!read) return writer;
  const wrap = (orgId: string, id: string, work: () => Promise<void>, forceLog = false) => recordHistoryWrite(orgId, kind, id, () => read(orgId, id), work, forceLog);
  const out = Object.assign(Object.create(writer) as EntityWriter, {
    update: (orgId: string, id: string, fields: Record<string, unknown>) => wrap(orgId, id, () => writer.update(orgId, id, fields)),
  });
  if (writer.mergeMetadata) out.mergeMetadata = (orgId, id, fields) => wrap(orgId, id, () => writer.mergeMetadata!(orgId, id, fields));
  if (writer.restore) out.restore = (orgId, image) => wrap(orgId, String(image.id), () => writer.restore!(orgId, image), true);
  if (writer.retire) out.retire = (orgId, id, how) => wrap(orgId, id, () => writer.retire!(orgId, id, how));
  if (writer.unretire) out.unretire = (orgId, id) => wrap(orgId, id, () => writer.unretire!(orgId, id));
  return out;
}

export async function recordHistoryWrite(orgId: string, kind: string, id: string, read: () => Promise<Record<string, unknown> | null>, work: () => Promise<void>, forceLog = false): Promise<void> {
  const active = currentHistoryWrite(orgId, kind, id);
  if (active && !active.logged) return work();
  const before = await read();
  if (!before) return work();
  const write: HistoryWrite = { orgId, kind, id, before, readAfter: read, logged: false, forceLog };
  await runHistoryWrite(write, async () => { await work(); await finishHistoryWrite(write); });
}
