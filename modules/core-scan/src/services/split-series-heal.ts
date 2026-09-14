// The rows a split already gave the group photo's series heal (#3013).
//
// Until the split judged the parent's whole-photo keys per piece
// (split-inherit.ts, inheritedMeta), every child of a split carried the
// parent's `series`: the vision's series for the frame, "Wicked" for a
// photo of a Wicked set beside a Holiday picture frame. The inbox then
// counted both as Wicked members. This is the self-heal for what was
// written before the rule existed: a pending split child whose `series`
// is its parent's, whose own name and own sentence do not name it, and
// whose identity is still the split's (no identify pass of its own crop
// has answered since) has the series MOVED to `split_dropped.series`.
// Nothing is deleted: the value stays on the row, only no longer claimed.
//
// Two doors and a cadence, in that order: a read-only count per workspace
// (the audit), the heal on request, and the same heal a page a minute in
// the background, like the retrim of stored pictures, so every workspace
// heals on its own without anybody running anything (CLAUDE.md §8.1).
// Every row visited is stamped `split_series_judged`, healed or not, so a
// second look costs nothing and a child re-identified later is never
// touched twice.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";

/** Rows per workspace per tick. */
export const SPLIT_SERIES_PER_TICK = 50;
const TICK_MS = 20 * 60 * 1000;
const DRAIN_MS = 60 * 1000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let drainHandle: ReturnType<typeof setTimeout> | null = null;

export function startSplitSeriesHealer(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 120_000);
  console.log(`[core-scan] split-series healer started — every ${TICK_MS / 60_000} min, a page a minute while there is a backlog`);
}

async function safeTick(): Promise<void> {
  try {
    let backlog = false;
    await platform().exclusive.run("core-scan.split-series-heal", async () => {
      backlog = (await splitSeriesTick()).backlog;
    });
    if (backlog) {
      if (drainHandle) clearTimeout(drainHandle);
      drainHandle = setTimeout(safeTick, DRAIN_MS);
    }
  } catch (err) {
    console.error("[core-scan] split-series heal failed:", (err as Error).stack ?? (err as Error).message);
  }
}

export interface SplitChildRow {
  id: string;
  suggested_name: string | null;
  suggested_metadata: Record<string, unknown> | null;
}

export interface SplitSeriesVerdict {
  drop: boolean;
  series: string | null;
  why: "no-series" | "not-a-split-child" | "already-judged" | "re-identified" | "parent-says-otherwise" | "named" | "unnamed";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const mentions = (text: string | null | undefined, value: string): boolean => {
  const v = norm(value);
  if (!v || !text) return false;
  return new RegExp(`(?:^|\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(norm(text));
};

/**
 * Should this child's series be moved to split_dropped? Pure: the rule,
 * with the parent's series as the caller found it (null when the parent is
 * gone, which is not evidence either way and leaves the row alone).
 */
export function splitSeriesVerdict(child: SplitChildRow, parentSeries: string | null): SplitSeriesVerdict {
  const meta = child.suggested_metadata ?? {};
  const series = typeof meta.series === "string" && meta.series.trim() ? meta.series.trim() : null;
  if (!series) return { drop: false, series, why: "no-series" };
  const inherited = meta.split_inherited as { observation?: string | null; meta_kept?: Record<string, unknown> } | null | undefined;
  if (!meta.split_from || !inherited) return { drop: false, series, why: "not-a-split-child" };
  // A child the rule already judged carries its own record of why the
  // series stands; nothing to heal.
  if (inherited.meta_kept && typeof inherited.meta_kept === "object") return { drop: false, series, why: "already-judged" };
  // An identify pass of the child's own crop rewrites `source` and its
  // series is then its own answer, whatever the parent said.
  if (meta.source !== "vision-split") return { drop: false, series, why: "re-identified" };
  if (parentSeries === null || norm(parentSeries) !== norm(series)) return { drop: false, series, why: "parent-says-otherwise" };
  if (mentions(child.suggested_name, series) || mentions(inherited.observation ?? null, series)) return { drop: false, series, why: "named" };
  return { drop: true, series, why: "unnamed" };
}

interface AuditRow extends SplitChildRow {
  parent_series: string | null;
}

/** The next page of unjudged pending split children of one workspace, each
 *  with its parent's series as it stands now. */
async function unjudgedPage(orgId: string, limit: number): Promise<AuditRow[]> {
  let rows: AuditRow[] = [];
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const q = sql<AuditRow>`
      select c.id, c.suggested_name, c.suggested_metadata,
             p.suggested_metadata->>'series' as parent_series
      from core_scan_inbox_items c
      left join core_scan_inbox_items p on p.id::text = c.suggested_metadata->>'split_from'
      where c.status = 'pending'
        and c.suggested_metadata->>'split_from' is not null
        and c.suggested_metadata->>'series' is not null
        and (c.suggested_metadata->'split_series_judged') is null
      order by c.created_at desc
      limit ${limit}
    `.compile(tdb);
    rows = (await tdb.executeQuery(q)).rows as AuditRow[];
  });
  return rows;
}

export interface SplitSeriesAudit {
  scanned: number;
  count: number;
  capped: boolean;
  items: Array<{ id: string; suggested_name: string | null; series: string; parent_series: string | null }>;
}

/** Read-only: how many pending split children of this workspace carry a
 *  series the rule would move, and which. Writes nothing. */
export async function auditSplitSeries(orgId: string, cap = 1000): Promise<SplitSeriesAudit> {
  const rows = await unjudgedPage(orgId, cap + 1);
  const capped = rows.length > cap;
  const scanned = capped ? rows.slice(0, cap) : rows;
  const items = scanned
    .map((r) => ({ r, v: splitSeriesVerdict(r, r.parent_series) }))
    .filter(({ v }) => v.drop)
    .map(({ r, v }) => ({ id: r.id, suggested_name: r.suggested_name, series: v.series!, parent_series: r.parent_series }));
  return { scanned: scanned.length, count: items.length, capped, items };
}

/** One workspace, one page: every unjudged split child is judged and
 *  stamped; the ones the rule moves have their series moved. */
export async function healSplitSeriesWorkspace(orgId: string, limit = SPLIT_SERIES_PER_TICK): Promise<{ visited: number; healed: number; items: string[] }> {
  const rows = await unjudgedPage(orgId, limit);
  const healed: string[] = [];
  for (const row of rows) {
    const v = splitSeriesVerdict(row, row.parent_series);
    await platform().tenants.withDb(orgId, async (raw) => {
      const tdb = raw as Kysely<unknown>;
      const dropped = { ...((row.suggested_metadata?.split_dropped as Record<string, unknown> | undefined) ?? {}), series: v.series };
      const stamp = { split_series_judged: { at: new Date().toISOString(), why: v.why } };
      const q = v.drop
        ? sql`
            update core_scan_inbox_items
               set suggested_metadata = (coalesce(suggested_metadata, '{}'::jsonb) - 'series') || ${JSON.stringify({ ...stamp, split_dropped: dropped })}::jsonb,
                   updated_at = now()
             where id = ${row.id}
               and suggested_metadata->>'series' = ${v.series}
          `
        : sql`
            update core_scan_inbox_items
               set suggested_metadata = coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb
             where id = ${row.id}
          `;
      await tdb.executeQuery(q.compile(tdb));
    });
    if (v.drop) healed.push(row.id);
  }
  return { visited: rows.length, healed: healed.length, items: healed };
}

export async function splitSeriesTick(opts: { orgId?: string } = {}): Promise<{ visited: number; healed: number; backlog: boolean }> {
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
    console.warn("[core-scan] split-series heal skipped — meta read failed:", (err as Error).message);
    return { visited: 0, healed: 0, backlog: false };
  }
  let visited = 0;
  let healed = 0;
  let backlog = false;
  for (const { id: orgId } of orgs) {
    try {
      const done = await healSplitSeriesWorkspace(orgId);
      visited += done.visited;
      healed += done.healed;
      if (done.visited >= SPLIT_SERIES_PER_TICK) backlog = true;
    } catch (err) {
      console.warn(`[core-scan] split-series heal skipped org ${orgId}:`, (err as Error).message);
    }
  }
  if (visited > 0) console.log(`[core-scan] split-series heal: ${healed} of ${visited} split child(ren) had the group's series moved to split_dropped${backlog ? "; more waiting, next page in a minute" : ""}`);
  return { visited, healed, backlog };
}
