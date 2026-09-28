// A person's hint is never dropped because the AI was busy (#3819).
//
// Someone typed "actually ldo v0.2 s1 kit" under a photo and pressed Re-run.
// The AI answered 503 three times, the row kept its old name, and the hint
// went nowhere. The hint is the person telling us what the thing is; it does
// not need a model to be applied. So when the read fails for a reason that
// passes (busy, unreachable, a limit), the hint names the item, the picture
// search runs on the new name, and a real AI re-run is queued for when the
// provider answers again. The AI refines the name then; until then the card
// says where the name came from.

import { sql } from "kysely";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";
import type { CoreScanDB } from "../db.js";

/** The sentence on a row renamed from a hint while the AI was away. */
export const RENAMED_FROM_HINT_NOTE = "Renamed from your hint; the AI will refine it when it's back.";

/** Reasons the AI may answer to later: worth queueing a re-run for. A key
 *  that is not valid, or a model that is gone, will not fix itself. */
const PASSING_REASONS = new Set(["busy", "unreachable", "quota"]);

/** How often, and for how long, a queued re-run is tried. */
export const RERUN_EVERY_MS = 10 * 60_000;
export const RERUN_MAX_ATTEMPTS = 12;

/** Conversational words a hint opens with that are not part of the name. */
const LEAD_IN = /^(?:(?:actually|no|nope|nah|wait|oh|ok|okay|well|so|hmm|it'?s|it is|its|this is|that'?s|that is|they'?re|they are|should be|is|a|an|the|just|really|more like)\b[\s,:;.!-]*)+/i;

/** Short words a name keeps lower case. Everything else of three letters or
 *  fewer reads as an initialism (LDO, JBL), and a word mixing letters and
 *  digits reads as a model code (S1, V0.2). */
const PLAIN_WORDS = new Set(["kit", "set", "box", "bag", "and", "for", "with", "the", "of", "in", "on", "a", "an", "or", "to", "pro", "max", "one", "two", "red", "tan", "big", "new", "old", "mini", "pack", "case"]);

/** The name a hint gives, or null when the hint does not name anything (it
 *  is a question, or runs on like a sentence). Pure. A brand the hint names
 *  is part of the name it gives ("LDO"); a word the row already spells keeps
 *  the row's spelling. */
export function nameFromHint(hint: string, current: { name?: string | null; brand?: string | null } = {}): string | null {
  let h = hint.trim().replace(/\s+/g, " ");
  if (!h || h.endsWith("?")) return null;
  h = h.replace(LEAD_IN, "").replace(/^[\s,:;.!-]+|[\s,:;.!]+$/g, "");
  if (!h || h.length < 2 || h.split(" ").length > 12) return null;
  // Words the current name already spells keep its spelling ("voron" is
  // "Voron" if the row said so).
  const known = new Map<string, string>();
  for (const w of `${current.name ?? ""} ${current.brand ?? ""}`.split(/[\s,()]+/)) if (w) known.set(w.toLowerCase(), w);
  const words = h.split(" ").map((w, i) => {
    const lower = w.toLowerCase();
    const k = known.get(lower);
    if (k) return k;
    // A version keeps its small v ("v0.2"); any other code of letters and
    // digits is written the way labels print it ("S1", "MK4").
    if (/^v\d/i.test(w)) return `v${w.slice(1)}`;
    if (/[a-z]/i.test(w) && /\d/.test(w)) return w.toUpperCase();
    if (/^[a-z]{2,3}$/i.test(w) && !PLAIN_WORDS.has(lower)) return w.toUpperCase();
    if (w !== lower) return w;
    return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  });
  return words.join(" ");
}

/** Whether a failed read is worth asking again later. */
export function aiMayAnswerLater(failure: IdentifyFailure): boolean {
  return failure.code === "ai_unavailable" && failure.ai === "provider-error" && !!failure.ai_reason && PASSING_REASONS.has(failure.ai_reason);
}

interface QueuedRerun {
  at: string;
  next_at: string;
  attempts: number;
  user_id: string | null;
  hint?: string;
  hints?: string[];
}

/** After a read the AI could not do for a passing reason: apply the hint the
 *  person typed, look for a picture of what they named, and queue a real
 *  re-run. Returns the name it gave the row, or null. */
export async function applyHintWithoutAi(
  db: Kysely<CoreScanDB>,
  opts: { orgId: string; itemId: string; failure: IdentifyFailure; hint?: string; hints?: string[]; userId?: string | null },
): Promise<string | null> {
  if (!aiMayAnswerLater(opts.failure)) return null;
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_name", "suggested_manufacturer", "suggested_metadata"])
    .where("id", "=", opts.itemId)
    .executeTakeFirst();
  if (!row) return null;
  const prior = (row.suggested_metadata as { ai_rerun_queued?: QueuedRerun } | null)?.ai_rerun_queued;
  const attempts = (prior?.attempts ?? 0) + 1;
  const now = new Date();
  const queued: QueuedRerun | null =
    attempts > RERUN_MAX_ATTEMPTS
      ? null
      : {
          at: prior?.at ?? now.toISOString(),
          next_at: new Date(now.getTime() + RERUN_EVERY_MS).toISOString(),
          attempts,
          user_id: opts.userId ?? prior?.user_id ?? null,
          ...(opts.hint ?? prior?.hint ? { hint: opts.hint ?? prior?.hint } : {}),
          ...(opts.hints?.length ? { hints: opts.hints } : prior?.hints ? { hints: prior.hints } : {}),
        };
  const name = opts.hint ? nameFromHint(opts.hint, { name: row.suggested_name, brand: row.suggested_manufacturer }) : null;
  const renamed = name && name !== row.suggested_name ? name : null;
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      ...(renamed ? { suggested_name: renamed, ai_notes: RENAMED_FROM_HINT_NOTE } : {}),
      suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'ai_rerun_queued') || ${JSON.stringify({
        ...(queued ? { ai_rerun_queued: queued } : {}),
        ...(renamed ? { renamed_from_hint: { hint: opts.hint, from: row.suggested_name, at: now.toISOString() } } : {}),
      })}::jsonb` as never,
      updated_at: now,
    })
    .where("id", "=", opts.itemId)
    .execute();
  if (renamed) {
    console.log(`[core-scan] org ${opts.orgId} row ${opts.itemId}: renamed from the hint while the AI was away`);
    // A picture of what the person named, on the ladder every search climbs.
    const { refreshCatalogImageByName } = await import("./enrich-photo.js");
    void refreshCatalogImageByName(opts.orgId, opts.itemId, renamed, row.suggested_manufacturer).catch((err) =>
      console.error(`[core-scan] picture search for the hint's name failed:`, (err as Error).message),
    );
  }
  return renamed;
}

/** The kernel's walk, every ten minutes: rows whose read is queued and due
 *  are read again, a few per workspace per round. A read that fails again for
 *  a passing reason queues itself again (applyHintWithoutAi); twelve tries
 *  and it stops, the card keeping its last honest sentence. */
export function registerAiRerunSweep(): void {
  platform().sweeps.register({
    name: "core-scan.ai-rerun-when-back",
    everyMs: RERUN_EVERY_MS,
    module: "core-scan",
    visit: async ({ orgId, db, now }) => {
      const tdb = db as Kysely<CoreScanDB>;
      const due = await tdb
        .selectFrom("core_scan_inbox_items")
        .select(["id", "image_file_id", "suggested_metadata"])
        .where("status", "=", "pending")
        .where("image_file_id", "is not", null)
        .where(sql<boolean>`suggested_metadata ? 'ai_rerun_queued'`)
        .where(sql<boolean>`(suggested_metadata->'ai_rerun_queued'->>'next_at')::timestamptz <= ${now.toISOString()}::timestamptz`)
        .limit(3)
        .execute();
      if (!due.length) return;
      const { enrichPhotoItem } = await import("./enrich-photo.js");
      for (const r of due) {
        const q = (r.suggested_metadata as { ai_rerun_queued?: QueuedRerun }).ai_rerun_queued!;
        try {
          await enrichPhotoItem({
            db: tdb,
            orgId,
            itemId: r.id,
            imageFileId: r.image_file_id!,
            userId: q.user_id,
            force: true,
            ...(q.hint ? { hint: q.hint } : {}),
            ...(q.hints ? { hints: q.hints } : {}),
          });
        } catch (err) {
          console.error(`[core-scan] org ${orgId} row ${r.id}: queued AI re-run failed:`, (err as Error).message);
        }
      }
      return { backlog: due.length === 3 };
    },
  });
}
