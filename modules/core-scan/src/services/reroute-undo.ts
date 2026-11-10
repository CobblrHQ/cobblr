// The way back from the re-route pass (#9380): a row it moved goes back on the
// list it had, kept under `reroute_prior`, by row or for the whole workspace.
// The pass runs on every workspace, a shared database included, and nobody
// checks each move first; a move found wrong is one request to undo, not a
// hand edit per row.
//
// Never over what happened since: a row a person answered after the move
// (typed values, "looks fine", a list they chose), one filed or no longer
// waiting, or one whose route changed again since is skipped and says why.
// The write is a compare-and-set on the list that was read. A row put back is
// stamped `reroute.undone`, and the pass never asks it again, under these
// rules or later ones: putting it back said the move was wrong.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { storedDestinationOf } from "@cobblr/platform-contract/scan-triage";

export type UndoWhy = "not-moved" | "not-pending" | "filed" | "person-changed" | "changed-since";

export interface UndoRow {
  id: string;
  status: string;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: unknown;
  target_module: string | null;
  target_entity_id: string | null;
}

export interface RerouteUndo {
  restored: string[];
  skipped: Array<{ id: string; why: UndoWhy }>;
}

const listOf = (raw: unknown): Array<Record<string, unknown>> => {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    // pass-catch: an unparseable list has nothing to put back
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
};

const labelOf = (c: Record<string, unknown> | undefined): string => (c ? String(c.label ?? `${String(c.module ?? "")}:${String(c.instance ?? "")}`) : "");

/** Whether one row goes back, and if not, why. Pure. */
export function undoVerdict(row: UndoRow): { action: "restore"; prior: Array<Record<string, unknown>> } | { action: "skip"; why: UndoWhy } {
  const meta = row.suggested_metadata ?? {};
  const stamp = meta.reroute as { to?: unknown; undone?: unknown } | undefined;
  const prior = listOf(meta.reroute_prior);
  if (!stamp || typeof stamp.to !== "string" || stamp.undone || !prior.length) return { action: "skip", why: "not-moved" };
  if (row.status !== "pending") return { action: "skip", why: "not-pending" };
  if (row.target_entity_id || row.target_module) return { action: "skip", why: "filed" };
  if (meta.user_fields || meta.reviewed === true || storedDestinationOf(meta)?.by === "person") return { action: "skip", why: "person-changed" };
  if (labelOf(listOf(row.suggested_candidates)[0]) !== stamp.to) return { action: "skip", why: "changed-since" };
  return { action: "restore", prior };
}

/** Put the moved rows of one workspace back: those named, or all of them. */
export async function undoReroutes(orgId: string, opts: { ids?: readonly string[] } = {}): Promise<RerouteUndo> {
  const out: RerouteUndo = { restored: [], skipped: [] };
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const only = opts.ids?.length ? sql`and id::text = any(${[...opts.ids]}::text[])` : sql``;
    const { rows } = await tdb.executeQuery(
      sql<UndoRow>`
        select id, status, suggested_metadata, suggested_candidates, target_module, target_entity_id
        from core_scan_inbox_items
        where suggested_metadata ? 'reroute_prior' ${only}
        order by created_at, id
      `.compile(tdb),
    );
    for (const row of rows as UndoRow[]) {
      const v = undoVerdict(row);
      if (v.action === "skip") {
        if (v.why !== "not-moved") out.skipped.push({ id: row.id, why: v.why });
        continue;
      }
      const stamp = (row.suggested_metadata?.reroute ?? {}) as Record<string, unknown>;
      const r = await tdb.executeQuery(
        sql`
          update core_scan_inbox_items
             set suggested_candidates = ${JSON.stringify(v.prior)}::jsonb,
                 suggested_metadata = (coalesce(suggested_metadata, '{}'::jsonb) - 'reroute_prior') || ${JSON.stringify({ reroute: { ...stamp, undone: new Date().toISOString() } })}::jsonb,
                 updated_at = now()
           where id = ${row.id}
             and status = 'pending'
             and suggested_candidates = ${JSON.stringify(listOf(row.suggested_candidates))}::jsonb
        `.compile(tdb),
      );
      if (Number(r.numAffectedRows ?? 0) > 0) out.restored.push(row.id);
      else out.skipped.push({ id: row.id, why: "changed-since" });
    }
  });
  return out;
}
