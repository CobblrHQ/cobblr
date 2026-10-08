import type { HistoryWriter } from "@cobblr/platform-contract";
import { baseKindOf, getEntityWriterFor } from "./entities.js";
import { recordHistoryWrite } from "./history-writes.js";

const writers = new Map<string, HistoryWriter>();
export function registerHistoryWriter(kind: string, writer: HistoryWriter): void {
  writers.set(kind, {
    table: writer.table,
    snapshotDeletion: writer.snapshotDeletion?.bind(writer),
    restoreDeletion: writer.restoreDeletion?.bind(writer),
    snapshot: (orgId, id) => writer.snapshot(orgId, id),
    restore: (orgId, image) => recordHistoryWrite(orgId, kind, String(image.id), () => writer.snapshot(orgId, String(image.id)), () => writer.restore(orgId, image), true),
  });
}

export async function historyTableFor(orgId: string, kind: string): Promise<string | undefined> {
  return (await getEntityWriterFor(orgId, kind))?.table ?? writers.get(await baseKindOf(orgId, kind))?.table;
}

export async function getHistoryWriterFor(orgId: string, kind: string): Promise<HistoryWriter | null> {
  const full = await getEntityWriterFor(orgId, kind);
  if (full?.snapshot && full.restore) return { snapshot: full.snapshot.bind(full), restore: full.restore.bind(full), snapshotDeletion: full.snapshotDeletion?.bind(full), restoreDeletion: full.restoreDeletion?.bind(full) };
  return writers.get(await baseKindOf(orgId, kind)) ?? null;
}
