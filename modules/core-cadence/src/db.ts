// Tenant-side types + the ledger read/write. The engine (model.ts) stays pure;
// this is the thin adapter that feeds it rows and nothing more.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { CadenceEvent } from "./model.js";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface CoreCadenceEventsTable {
  id: Generated<string>;
  entity_kind: string;
  entity_id: string;
  event_type: "purchase" | "consume" | "adjust" | "discard";
  /** numeric in PG — comes back as a string, so always coerce on read. */
  qty_delta: string | number;
  context: Generated<"normal" | "one_off" | "bulk" | "faster">;
  source: Generated<"scan" | "list" | "manual" | "wire" | "checkin">;
  unit_price: string | number | null;
  occurred_at: Generated<Date>;
  user_id: string | null;
  created_at: Generated<Date>;
}

export interface CoreCadenceDB {
  core_cadence_events: CoreCadenceEventsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

interface RequestWithTenant {
  tenant?: { org: { id: string; name: string; slug: string }; role: OrgRole; db: unknown };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<CoreCadenceDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-cadence route called without tenant context");
  return t.db as Kysely<CoreCadenceDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-cadence route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUserId(req: Request): string | null {
  return (req as unknown as RequestWithTenant).session?.id ?? null;
}

/**
 * One item's history, oldest first, in the shape the engine wants.
 *
 * PG `numeric` arrives as a string; coercing here (not in the engine) keeps the
 * model pure and free of driver quirks.
 */
export async function loadEvents(
  db: Kysely<CoreCadenceDB>,
  entityKind: string,
  entityId: string,
): Promise<CadenceEvent[]> {
  const rows = await db
    .selectFrom("core_cadence_events")
    .select(["event_type", "qty_delta", "context", "occurred_at"])
    .where("entity_kind", "=", entityKind)
    .where("entity_id", "=", entityId)
    .orderBy("occurred_at", "asc")
    .execute();
  return rows.map((r) => ({
    event_type: r.event_type,
    qty_delta: Number(r.qty_delta),
    context: r.context,
    occurred_at: new Date(r.occurred_at),
  }));
}
