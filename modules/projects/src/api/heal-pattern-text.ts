// One-shot heal: keep the words of pattern PDFs read before words were kept,
// so search finds those patterns by what is in them too.
//
// DONE WHEN: no tenant DB has a projects_pattern_texts row with pending true.
// Check with, per tenant:
//   select count(*) from projects_pattern_texts where pending;
// /healthz reports it (noteHealShim, through registerHealPass). When it reads
// 0 on prod, staging and dev, delete this file and its boot call.
//
// SINCE BY MARKER: only migration 0006 sets pending, on the rows that existed
// before it, so the flag itself says "made before the fix"; no row made
// since carries it.
//
// WHY IT EXISTS: migration 0006 marks every project that existed before it as
// pending. A pattern whose PDF lands from now on is kept by the reader itself
// (runPatternRead), so nothing makes a new pending row.
//
// Trickled: a visit reads at most PER_VISIT PDFs, each a full parse of the
// file, and the kernel's sweep brings it back to a workspace that still has
// pending rows on its next round, under the shared connection budget. A
// project with no pattern PDF is settled in the same visit at the cost of
// one attachment lookup.

import type { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { ProjectsDB } from "../db.js";
import { latestPatternFileId } from "./pattern-photo.js";
import { patternText } from "./pattern-needs.js";
import { storePatternText } from "./pattern-text.js";

/** PDFs parsed per workspace per round. Cheap to lift; a parse is the cost. */
export const PER_VISIT = 10;

/** Where a visit reads and keeps: the tenant tables, or a test's memory. */
export interface PatternTextStore {
  /** Up to `limit` projects still pending. */
  pending(limit: number): Promise<string[]>;
  keep(projectId: string, fileId: string | null, text: string | null): Promise<void>;
}

/** A pattern's latest pattern PDF and its words (null text: none to read). */
export type ReadPattern = (projectId: string) => Promise<{ fileId: string; text: string | null } | null>;

/** Settle one workspace's pending patterns, a visit's worth. Answers how many
 *  were pending when it started (0 = clean). */
export async function healPatternTextIn(store: PatternTextStore, read: ReadPattern): Promise<{ pending: number; kept: number }> {
  const pending = await store.pending(PER_VISIT + 1);
  let kept = 0;
  for (const projectId of pending.slice(0, PER_VISIT)) {
    const got = await read(projectId);
    await store.keep(projectId, got?.fileId ?? null, got?.text ?? null);
    if (got?.text) kept++;
  }
  return { pending: pending.length, kept };
}

export function kyselyPatternTextStore(db: Kysely<ProjectsDB>): PatternTextStore {
  return {
    pending: async (limit) =>
      (await db.selectFrom("projects_pattern_texts").select("project_id").where("pending", "=", true).limit(limit).execute()).map((r) => r.project_id),
    keep: (projectId, fileId, text) => storePatternText(db, projectId, fileId, text),
  };
}

/** The reader's own extraction, for one pattern's latest pattern PDF. */
export function patternReader(orgId: string): ReadPattern {
  return async (projectId) => {
    const fileId = await latestPatternFileId(orgId, projectId);
    if (!fileId) return null;
    const got = await patternText(orgId, fileId);
    return { fileId, text: "error" in got ? null : got.text };
  };
}

/** Call from onBoot. The kernel's walk and budget, never a walk of its own. */
export function registerPatternTextHeal(): void {
  registerHealPass({
    name: "projects.heal-pattern-text",
    since: "2026-09-29T18:24:50Z",
    shim: "modules/projects/src/api/heal-pattern-text.ts",
    module: "projects",
    visit: async ({ orgId, db }) => {
      const r = await healPatternTextIn(kyselyPatternTextStore(db as Kysely<ProjectsDB>), patternReader(orgId));
      if (r.kept) console.log(`[projects] org ${orgId}: kept the words of ${r.kept} pattern PDF${r.kept === 1 ? "" : "s"} for search`);
      return r.pending;
    },
  });
}
