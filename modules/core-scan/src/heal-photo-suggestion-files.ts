// One-shot heal: a picture suggested for a record and never used leaves Files
// for the suggestion store (#7447).
//
// DONE WHEN: no tenant DB has a core_scan_record_photo_suggestions row whose
// status is not 'applied' and whose file_id is set. Check with, per tenant:
//   select count(*) from core_scan_record_photo_suggestions
//    where status <> 'applied' and file_id is not null;
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call.
//
// BORN WITH: nothing (a suggestion now holds its picture in the suggestion
// store and is written into Files only by Use it, so a new workspace never has
// a suggestion's file).
//
// WHY IT EXISTS: from 2026-09-28 (16697fde25, ada44f7636) each suggested
// picture was stored as a file the moment it was found, and on upgrade the
// backfill searched the web for every existing record, so an upgraded
// workspace's Files doubled with pictures nobody had accepted, and a No thanks
// kept its file. Such a file is moved back: its bytes are read into the
// suggestion row, and only then is the file removed. A file that is attached
// to something, that a record now shows, or that is not the suggestion's own
// download (a person's identical picture the writer handed back) stays where
// it is. No byte is ever dropped.
//
// SINCE BY MARKER: only the code from before the fix ever stored an unaccepted
// suggestion's picture as a file (fixed code holds it in the row until Use it),
// so the shape alone is the broken row, whatever its date. A date limit missed
// the rows an older nightly keeps writing until its box upgrades: 2026.8.1 →
// nightly-2026-10-05 → the 2026.10.0 candidate doubled Files in the release
// check (run 55860), its 10-05 rows dated after the fix.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { FileDescription } from "@cobblr/platform-contract";

interface HealDB {
  core_scan_record_photo_suggestions: {
    entity_kind: string;
    entity_id: string;
    status: string;
    file_id: string | null;
    source_url: string | null;
    held_bytes: Buffer | null;
    held_type: string | null;
    held_name: string | null;
    attempts: number;
    created_at: Date;
    updated_at: Date;
  };
}

/** Per visit, so a workspace with hundreds is worked through over a few boots. */
const PER_VISIT = 50;

export interface HealSeams {
  describe: (orgId: string, fileIds: string[]) => Promise<FileDescription[] | null>;
  attachedTo: (orgId: string, fileId: string) => Promise<unknown[] | null>;
  recordImagePath: (orgId: string, kind: string, id: string) => Promise<string | null>;
  read: (orgId: string, fileId: string) => Promise<Uint8Array | null>;
  remove: (orgId: string, fileId: string) => Promise<boolean | null>;
}

const REAL: HealSeams = {
  describe: (orgId, ids) => platform().files.describe(orgId, ids),
  attachedTo: (orgId, fileId) => platform().files.attachmentsOfFile(orgId, fileId),
  recordImagePath: async (orgId, kind, id) => {
    const e = await platform().entities.lookup(orgId, kind, id).catch(() => null);
    return typeof e?.image_path === "string" ? e.image_path : null;
  },
  read: async (orgId, fileId) => {
    const got = await platform().files.read(orgId, fileId, "original");
    return got ? new Uint8Array(got.bytes) : null;
  },
  remove: (orgId, fileId) => platform().files.removeForGood(orgId, fileId),
};

/** What becomes of one unaccepted suggestion's file. Pure. */
export function verdictFor(
  row: { source_url: string | null },
  file: { photoSource: unknown } | null,
  attachments: number,
  shownOnRecord: boolean,
): "gone" | "in-use" | "not-ours" | "move" {
  if (!file) return "gone";
  if (attachments > 0 || shownOnRecord) return "in-use";
  // Only the suggestion's own download is moved: the writer hands back a file
  // that already holds the same bytes, which may be a person's own picture.
  const src = file.photoSource as { kind?: unknown; original_url?: unknown } | null;
  if (src?.kind !== "web" || !row.source_url || src.original_url !== row.source_url) return "not-ours";
  return "move";
}

/** Heal one workspace. Cheap on the happy path: one indexed select. */
export async function healPhotoSuggestionFilesIn(orgId: string, db: Kysely<HealDB>, seams: HealSeams = REAL): Promise<number> {
  const T = "core_scan_record_photo_suggestions" as const;
  const rows = await db
    .selectFrom(T)
    .select(["entity_kind", "entity_id", "status", "file_id", "source_url"])
    // Fixed code names a file on a suggestion only once applied.
    .where("status", "<>", "applied")
    .where("file_id", "is not", null)
    .limit(PER_VISIT)
    .execute();
  if (!rows.length) return 0;
  // No file store to ask: nothing can be judged, so nothing is touched.
  const described = await seams.describe(orgId, rows.map((r) => r.file_id!));
  if (!described) return 0;
  const byId = new Map(described.map((d) => [d.fileId, d]));
  const tally = { moved: 0, inUse: 0, notOurs: 0, gone: 0 };
  for (const r of rows) {
    const fileId = r.file_id!;
    // Every write names the file it found: a row a person changed meanwhile is left.
    const update = (set: Partial<HealDB[typeof T]>) =>
      db.updateTable(T).set({ ...set, updated_at: new Date() }).where("entity_kind", "=", r.entity_kind).where("entity_id", "=", r.entity_id).where("file_id", "=", fileId).execute();
    try {
      const file = byId.get(fileId) ?? null;
      const attached = file ? ((await seams.attachedTo(orgId, fileId)) ?? []).length : 0;
      const shown = file ? ((await seams.recordImagePath(orgId, r.entity_kind, r.entity_id)) ?? "").includes(fileId) : false;
      const verdict = verdictFor(r, file, attached, shown);
      if (verdict === "in-use") {
        // Someone put it to use: it is theirs now, as if they had said Use it.
        await update({ status: "applied" });
        tally.inUse++;
        continue;
      }
      if (verdict === "gone" || verdict === "not-ours") {
        // Nothing of the suggestion's own to move: let go of the link, and a
        // suggestion left with no picture is looked for again (only once the
        // workspace has suggestions on).
        await update({ file_id: null, ...(r.status === "suggested" ? { status: "queued", attempts: 0 } : {}) });
        tally[verdict === "gone" ? "gone" : "notOurs"]++;
        continue;
      }
      // Move: the bytes into the suggestion row first, and only then the file
      // out of Files. A read that fails leaves both as they are.
      const bytes = await seams.read(orgId, fileId);
      if (!bytes?.length) continue;
      await update({ held_bytes: Buffer.from(bytes), held_type: file!.mimeType || "image/jpeg", held_name: file!.filename || "picture.jpg" });
      if ((await seams.remove(orgId, fileId)) === true) {
        await update({ file_id: null });
        tally.moved++;
      }
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-photo-suggestion-files", orgId, err);
      console.error(`[core-scan] org ${orgId} ${r.entity_kind}/${r.entity_id}: could not move its suggested picture out of Files:`, (err as Error).message);
    }
  }
  console.log(`[core-scan] org ${orgId}: suggested pictures out of Files: ${tally.moved} moved, ${tally.inUse} in use and kept, ${tally.notOurs} not the suggestion's own, ${tally.gone} already gone`);
  return rows.length;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerPhotoSuggestionFilesHeal(): void {
  registerHealPass({
    name: "core-scan.heal-photo-suggestion-files",
    since: "2026-10-20T00:00:00Z",
    shim: "modules/core-scan/src/heal-photo-suggestion-files.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healPhotoSuggestionFilesIn(orgId, db as Kysely<HealDB>),
  });
}
