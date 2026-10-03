import { platform } from "@cobblr/platform-contract";
import { LIBRARY_COPY } from "@cobblr/platform-contract/library";
import type { Db } from "./matching.js";

function activityRef(record: { kind: string; id: string }) {
  const [module, type] = record.kind.split(":", 2);
  return { module: module ?? null, entityType: type ?? "item", entityId: record.id };
}

/** Turn a finished service job into record state once. The service kernel has
 * already attached the output file before it emits services.job.done. */
export async function recordCompletedCopy(orgId: string, jobId: string): Promise<void> {
  const job = await platform().services.job(orgId, jobId);
  if (!job || job.status !== "done" || job.capability !== LIBRARY_COPY || !job.attach_to || !job.connection_id) return;
  const ref = typeof (job.input as { ref?: unknown } | null)?.ref === "string" ? (job.input as { ref: string }).ref : null;
  const file = job.files.find((f) => f.direction === "out" && f.name === "file");
  const filename = typeof (job.output as { name?: unknown } | null)?.name === "string" ? (job.output as { name: string }).name : null;
  if (!ref || !file || !filename) return;

  const db = (await platform().tenants.getDb(orgId)) as Db;
  const copied = await db
    .updateTable("core_documents_linked")
    .set({ copied_at: new Date(), copied_filename: filename, copied_file_id: file.file_id })
    .where("record_id", "=", job.attach_to.id)
    .where("connection_id", "=", job.connection_id)
    .where("ref", "=", ref)
    .where("copied_at", "is", null)
    .returning(["record_kind", "record_id", "copy_requested_by"])
    .executeTakeFirst();
  if (!copied) return;
  await platform().activity.log({
    orgId,
    userId: copied.copy_requested_by,
    action: "library_item_copied",
    ref: activityRef({ kind: copied.record_kind, id: copied.record_id }),
    diff: { item: filename },
  });
}

export function registerCopyCompletion(): void {
  platform().events.on("services.job.done", "core-documents.copy-completion", async (payload: unknown) => {
    const p = payload as { orgId?: unknown; jobId?: unknown; capability?: unknown };
    if (p.capability !== LIBRARY_COPY || typeof p.orgId !== "string" || typeof p.jobId !== "string") return;
    await recordCompletedCopy(p.orgId, p.jobId);
  });
}
