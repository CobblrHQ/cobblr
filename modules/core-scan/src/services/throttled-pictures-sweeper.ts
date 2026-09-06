// Pictures the search refused to look for, looked for again.
//
// The engine answers a burst from one address with 403, and it can hold that
// for hours - the staging host was refused for over ninety minutes after a
// single twelve-line receipt (2026-09-06). refreshCatalogImageByName stamps
// such a row `catalog_image_status: "throttled"` and tries ONCE more six
// minutes later. When the wall outlasts that, every line of the receipt sits
// on the card as "Picture search busy", and the only way it ever gets a
// picture is somebody pressing retry twelve times.
//
// So: a sweep, every twenty minutes, takes a few of the oldest throttled rows
// per workspace and asks again. Serial and spaced, through the same gate every
// search uses, so the sweep cannot itself be the burst. A row older than a day
// is left alone - by then the person has filed it or moved on, and a picture
// arriving on a resolved item is not worth a search.
//
// Bounded per tick on purpose. Six rows per workspace, per twenty minutes, is
// eighteen searches an hour from a workspace with a stuck receipt, which is
// well inside what the engine tolerates and clears a receipt in under an hour
// once the wall lifts.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { refreshCatalogImageByName } from "./enrich-photo.js";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 20 * 60 * 1000;
/** After the engine refuses, leave it alone for this long. A refused ask
 *  every twenty minutes is the trickle that keeps a block in place: the
 *  staging host stayed refused for three hours while this sweep kept knocking
 *  (2026-09-06). */
export const BACKOFF_MS = 60 * 60 * 1000;
let backoffUntil = 0;

/** Pure: is the engine still being given room? */
export function inBackoff(now: Date, until: number): boolean {
  return now.getTime() < until;
}
/** Rows per workspace per tick. */
export const PER_TICK = 6;
/** Older than this and the person has moved on. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ThrottledRow {
  id: string;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  status: string;
  created_at: Date | string;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: Array<{ category?: string; fields?: Record<string, unknown> }> | null;
}

/**
 * Which rows to ask for again, and in what order. Pure, so the rule is a test:
 * pending only, throttled only, younger than a day, oldest first, at most
 * PER_TICK - because the ones that have waited longest are the ones somebody
 * is most likely looking at.
 */
export function pickThrottled(rows: readonly ThrottledRow[], now: Date): ThrottledRow[] {
  const cutoff = now.getTime() - MAX_AGE_MS;
  return rows
    .filter((r) => r.status === "pending")
    .filter((r) => (r.suggested_metadata?.catalog_image_status ?? null) === "throttled")
    .filter((r) => new Date(r.created_at).getTime() >= cutoff)
    .filter((r) => !!r.suggested_name?.trim())
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, PER_TICK);
}

export function startThrottledPicturesSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 90_000); // after boot settles, behind the other sweeps
  console.log(`[core-scan] throttled-pictures sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  try {
    await platform().exclusive.run("core-scan.throttled-pictures-sweep", async () => {
      await throttledPicturesTick();
    });
  } catch (err) {
    console.error("[core-scan] throttled-pictures sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
}

export async function throttledPicturesTick(opts: { orgId?: string; now?: Date } = {}): Promise<{ asked: number; refused: boolean }> {
  const now = opts.now ?? new Date();
  let asked = 0;
  if (inBackoff(now, backoffUntil)) {
    console.log(`[core-scan] throttled-pictures sweep: backing off until ${new Date(backoffUntil).toISOString()}`);
    return { asked: 0, refused: false };
  }
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
    console.warn("[core-scan] throttled-pictures sweep skipped — meta read failed:", (err as Error).message);
    return { asked: 0, refused: false };
  }
  let refused = false;

  for (const { id: orgId } of orgs) {
    let picked: ThrottledRow[] = [];
    try {
      await platform().tenants.withDb(orgId, async (raw) => {
        const tdb = raw as Kysely<unknown>;
        // The jsonb filter is in SQL so a workspace with a big inbox pays for
        // its throttled rows, not for all of them.
        const q = sql<ThrottledRow>`
          select id, suggested_name, suggested_manufacturer, status, created_at,
                 suggested_metadata, suggested_candidates
          from core_scan_inbox_items
          where status = 'pending'
            and suggested_metadata->>'catalog_image_status' = 'throttled'
            and created_at > now() - interval '1 day'
          order by created_at asc
          limit ${PER_TICK * 2}
        `.compile(tdb);
        const rows = (await tdb.executeQuery(q)).rows;
        picked = pickThrottled(rows, now);
      });
    } catch (err) {
      console.warn(`[core-scan] throttled-pictures sweep skipped org ${orgId}:`, (err as Error).message);
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
        console.warn(`[core-scan] throttled-pictures retry failed for ${r.id}:`, (err as Error).message);
      }
    }
    if (refused) break;
  }
  if (asked > 0) console.log(`[core-scan] throttled-pictures sweep asked again for ${asked} row(s)${refused ? "; refused, backing off for an hour" : ""}`);
  return { asked, refused };
}
