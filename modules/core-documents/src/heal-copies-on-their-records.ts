// One-shot heal: a library copy recorded on a record before 2026-10-12 is
// attached to that record, so it opens from the record's files.
//
// DONE WHEN: no core_documents_linked row with copied_file_id set and
// copied_at before 2026-10-12 names a live file that has no core-files
// attachment to that row's record. Check prod, staging and dev, then delete
// this file and its onBoot call.
//
// BORN WITH: services.ts keys a job by where its result is attached
// (serviceJobIdentity), so every copy is its own record's job and its output
// is attached to that record as the job finishes.
//
// WHY IT EXISTS: the same document copied into a second record got the first
// record's finished job back, so the second record never got the file (#5873).
// Only copies made before the fix are healed: a copy someone has since taken
// off a record stays off.

import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Db } from "./matching.js";

const FIXED_ON = new Date("2026-10-12T00:00:00Z");

export async function healCopiesOnTheirRecords(orgId: string, db: Db): Promise<number> {
  const rows = await db
    .selectFrom("core_documents_linked")
    .select(["record_kind", "record_id", "copied_file_id"])
    .where("copied_file_id", "is not", null)
    .where("copied_at", "<", FIXED_ON)
    .execute();
  let healed = 0;
  for (const row of rows) {
    const [module, type] = row.record_kind.split(":", 2);
    if (!module || !row.copied_file_id) continue;
    const on = await platform().files.attachmentsOfFile(orgId, row.copied_file_id);
    if (on === null) continue;
    if (on.some((a) => a.source_module === module && a.source_type === (type ?? "item") && a.source_id === row.record_id)) continue;
    const done = await platform()
      .files.attach(orgId, { fileId: row.copied_file_id, source_module: module, source_type: type ?? "item", source_id: row.record_id, role: "file" })
      .catch(() => null);
    if (done && !done.existed) healed++;
  }
  return healed;
}

export function registerCopiesOnTheirRecordsHeal(): void {
  registerHealPass({
    name: "core-documents.heal-copies-on-their-records",
    shim: "modules/core-documents/src/heal-copies-on-their-records.ts",
    module: "core-documents",
    visit: ({ orgId, db }) => healCopiesOnTheirRecords(orgId, db as Db),
  });
}
