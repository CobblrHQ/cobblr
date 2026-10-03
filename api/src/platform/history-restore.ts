import { getHistoryWriterFor } from "./history-store.js";
import { baseKindOf, kindRecordForOrg, hiddenFieldsFor as hiddenKindFields } from "./entities.js";
import { hiddenFieldsFor } from "./field-scope-projection.js";
import { historyBag, restoreImage } from "./record-history.js";
import { changesIn } from "@cobblr/platform-contract/activity-changes";
import { IMPLICIT_EXPOSABLE_PROPS } from "@cobblr/platform-contract/entity-metadata";

export async function hiddenHistoryFields(orgId: string, kind: string, userId: string, role: string, diff: unknown): Promise<Set<string>> {
  const hidden = await hiddenFieldsFor(orgId, userId, role);
  for (const field of await hiddenKindFields(orgId, kind, { userId, role })) hidden.add(field);
  const rec = await kindRecordForOrg(orgId, kind);
  if (rec?.exposable_fields) {
    const allowed = new Set([...rec.exposable_fields, ...rec.fields.map((f) => f.name), ...IMPLICIT_EXPOSABLE_PROPS]);
    const native = [...Object.keys(historyBag(historyBag(diff).version_before)), ...(changesIn(diff) ?? []).filter((c) => !c.custom).map((c) => c.field)];
    for (const field of native) if (!allowed.has(field) && field !== "changes" && field !== "version_before") hidden.add(field);
  }
  return hidden;
}

export class HistoryRestoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function restoreHistoryVersion(orgId: string, userId: string, role: string, kind: string, entityId: string, entryId: number, expectedLatestId: number): Promise<number> {
  const { meta } = await import("../db/meta.js");
  const [module, type] = (await baseKindOf(orgId, kind)).split(":");
  const selected = () => meta.selectFrom("activity_log").where("org_id", "=", orgId).where("module_name", "=", module!).where("entity_type", "=", type!).where("entity_id", "=", entityId);
  const entry = await selected().where("id", "=", entryId).select(["diff"]).executeTakeFirst();
  if (!entry || !Object.keys(historyBag(historyBag(entry.diff).version_before)).length) throw new HistoryRestoreError(404, "This entry has no saved version to restore.");
  const latest = await selected().select("id").orderBy("id", "desc").executeTakeFirst();
  if (Number(latest?.id) !== expectedLatestId) throw new HistoryRestoreError(409, "This record changed while you were reading its history. Refresh it before restoring.");
  const writer = await getHistoryWriterFor(orgId, kind);
  if (!writer?.snapshot || !writer.restore) throw new HistoryRestoreError(409, "This kind of record cannot restore a saved version.");
  const current = await writer.snapshot(orgId, entityId);
  if (!current) throw new HistoryRestoreError(404, "This record is no longer available.");
  if (historyBag(current.metadata).origin_ref || current._source_workspace_slug) throw new HistoryRestoreError(403, "This record belongs to another workspace.");
  const hidden = await hiddenFieldsFor(orgId, userId, role);
  for (const field of await hiddenKindFields(orgId, kind, { userId, role })) hidden.add(field);
  const image = restoreImage(current, entry.diff, hidden);
  if ("updated_at" in image) image.updated_at = new Date();
  await writer.restore(orgId, image);
  const restored = await selected().select("id").orderBy("id", "desc").executeTakeFirst();
  return Number(restored!.id);
}
