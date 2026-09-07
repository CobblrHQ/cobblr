// A row with no picture is a queue, not a dead end.
//
// This began as a sweep for rows the engine had REFUSED (2026-09-06: the
// staging host was refused for over ninety minutes after one twelve-line
// receipt, and every line sat on the card as "Picture search busy" until
// somebody pressed retry twelve times). It re-asked only those. A row whose
// first ask came back genuinely empty, or a row from before the status
// existed, stayed blank for good: a bunch of bananas sat with no tile under a
// strip of seven perfect banana photos, "updated 1 d ago" (2026-09-07).
// Something is better than nothing, and finding it is the system's job.
//
// So: every twenty minutes, a few of the oldest PENDING rows per workspace
// that have no picture and no hand-picked one are asked again, through the
// same ladder every surface climbs. A refused row waits for the engine's
// backoff; an honestly-empty row is asked again no more than once every six
// hours (it may be that the shop's photos were not indexed yet, or the
// engine was in a mood and answered with nothing rather than a refusal). A
// row older than a week is left alone - by then the person has filed it or
// moved on. Serial and spaced through the ladder's own gate, so the sweep
// cannot itself be the burst; bounded per tick so a workspace with a stuck
// receipt costs eighteen asks an hour, which the engine tolerates and which
// clears a receipt in under an hour once the wall lifts.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { refreshCatalogImageByName } from "./enrich-photo.js";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 20 * 60 * 1000;
/** After the engine refuses, leave it alone for this long. A refused ask
 *  every twenty minutes is the trickle that keeps a block in place. */
export const BACKOFF_MS = 60 * 60 * 1000;
let backoffUntil = 0;

/** Pure: is the engine still being given room? */
export function inBackoff(now: Date, until: number): boolean {
  return now.getTime() < until;
}
/** Rows per workspace per tick. */
export const PER_TICK = 6;
/** Older than this and the person has moved on. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** An honestly-empty answer is asked again no sooner than this. */
export const ASK_AGAIN_MS = 6 * 60 * 60 * 1000;

export interface UnpicturedRow {
  id: string;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  status: string;
  created_at: Date | string;
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: Array<{ category?: string; fields?: Record<string, unknown> }> | null;
}

function askedAt(r: UnpicturedRow): number | null {
  const v = r.suggested_metadata?.catalog_image_asked_at;
  if (typeof v !== "string") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Which rows to ask for again, and in what order. Pure, so the rule is a test:
 * pending only; no picture and none chosen by hand; a name to ask with;
 * younger than a week; a refused row whenever the engine is not in backoff,
 * any other unpictured row when it has not been asked in six hours; oldest
 * first, at most PER_TICK - the ones that have waited longest are the ones
 * somebody is most likely looking at.
 */
export function pickUnpictured(rows: readonly UnpicturedRow[], now: Date, engineBackedOff = false): UnpicturedRow[] {
  const cutoff = now.getTime() - MAX_AGE_MS;
  const askAgainBefore = now.getTime() - ASK_AGAIN_MS;
  return rows
    .filter((r) => r.status === "pending")
    .filter((r) => !r.catalog_image_file_id && !r.catalog_image_url)
    .filter((r) => !r.suggested_metadata?.catalog_image_user_set)
    .filter((r) => !!r.suggested_name?.trim())
    .filter((r) => new Date(r.created_at).getTime() >= cutoff)
    .filter((r) => {
      const status = r.suggested_metadata?.catalog_image_status ?? null;
      if (status === "throttled") return !engineBackedOff;
      const last = askedAt(r);
      return last === null || last <= askAgainBefore;
    })
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, PER_TICK);
}

export function startPicturesSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 90_000); // after boot settles, behind the other sweeps
  console.log(`[core-scan] pictures sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  try {
    await platform().exclusive.run("core-scan.throttled-pictures-sweep", async () => {
      await picturesTick();
    });
  } catch (err) {
    console.error("[core-scan] pictures sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
}

export async function picturesTick(opts: { orgId?: string; now?: Date } = {}): Promise<{ asked: number; refused: boolean }> {
  const now = opts.now ?? new Date();
  let asked = 0;
  const backedOff = inBackoff(now, backoffUntil);
  if (backedOff) console.log(`[core-scan] pictures sweep: engine backing off until ${new Date(backoffUntil).toISOString()}; refused rows wait`);
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) => j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "core-scan"))
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);
  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[core-scan] pictures sweep skipped — meta read failed:", (err as Error).message);
    return { asked: 0, refused: false };
  }
  let refused = false;

  for (const { id: orgId } of orgs) {
    let picked: UnpicturedRow[] = [];
    try {
      await platform().tenants.withDb(orgId, async (raw) => {
        const tdb = raw as Kysely<unknown>;
        // The filter is in SQL so a workspace with a big inbox pays for its
        // unpictured rows, not for all of them; the six-hour rule is applied
        // in pickUnpictured on the rows that come back.
        const q = sql<UnpicturedRow>`
          select id, suggested_name, suggested_manufacturer, status, created_at,
                 catalog_image_file_id, catalog_image_url,
                 suggested_metadata, suggested_candidates
          from core_scan_inbox_items
          where status = 'pending'
            and catalog_image_file_id is null
            and catalog_image_url is null
            and coalesce(suggested_metadata->>'catalog_image_user_set', 'false') <> 'true'
            and coalesce(suggested_name, '') <> ''
            and created_at > now() - interval '7 days'
          order by created_at asc
          limit ${PER_TICK * 4}
        `.compile(tdb);
        const rows = (await tdb.executeQuery(q)).rows;
        picked = pickUnpictured(rows, now, backedOff);
      });
    } catch (err) {
      console.warn(`[core-scan] pictures sweep skipped org ${orgId}:`, (err as Error).message);
      continue;
    }
    for (const r of picked) {
      const meta = r.suggested_metadata ?? {};
      const cand = r.suggested_candidates?.[0];
      const category = cand?.category ?? (cand?.fields?.food_category as string | undefined) ?? null;
      const soldBy = typeof meta.receipt_vendor === "string" ? meta.receipt_vendor : null;
      try {
        // `retrying: true` - the sweep is the retry; the function must not
        // schedule another of its own on top of it.
        const outcome = await refreshCatalogImageByName(orgId, r.id, r.suggested_name!, r.suggested_manufacturer, soldBy, category, true);
        asked++;
        if (outcome === "throttled") {
          // The engine said no. The rest of this tick would be the burst all
          // over again; stop here and give it an hour.
          refused = true;
          backoffUntil = now.getTime() + BACKOFF_MS;
          break;
        }
      } catch (err) {
        console.warn(`[core-scan] pictures sweep retry failed for ${r.id}:`, (err as Error).message);
      }
    }
    if (refused) break;
  }
  if (asked > 0) console.log(`[core-scan] pictures sweep asked for ${asked} row(s)${refused ? "; refused, backing off for an hour" : ""}`);
  return { asked, refused };
}
