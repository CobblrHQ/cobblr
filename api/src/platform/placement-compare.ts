import { sql, type QueryExecutorProvider } from "kysely";
import type { EntityRef, PlacementExpectation } from "@cobblr/platform-contract";

function matches(thing: EntityRef, expected: PlacementExpectation) {
  return sql`containee_kind = ${thing.kind} and containee_id = ${thing.id}
    and container_kind = ${expected.container?.kind} and container_id = ${expected.container?.id}
    and slot is not distinct from ${expected.slot ?? null}
    and metadata->'position' is not distinct from ${expected.position ? sql`${JSON.stringify(expected.position)}::jsonb` : sql`null`}`;
}

export async function comparePlacementWrite(db: QueryExecutorProvider, thing: EntityRef, expected: PlacementExpectation, to: {
  container: EntityRef; slot: string | null; metadata: Record<string, unknown>; userId: string | null;
}): Promise<void> {
  const metadata = JSON.stringify(to.metadata);
  const result = expected.container
    ? await sql`update core_placement_placements set container_kind = ${to.container.kind}, container_id = ${to.container.id},
        slot = ${to.slot}, metadata = ${metadata}::jsonb, placed_by = ${to.userId}, placed_at = now()
        where ${matches(thing, expected)} returning containee_id`.execute(db)
    : await sql`insert into core_placement_placements (containee_kind, containee_id, container_kind, container_id, slot, metadata, placed_by)
        values (${thing.kind}, ${thing.id}, ${to.container.kind}, ${to.container.id}, ${to.slot}, ${metadata}::jsonb, ${to.userId})
        on conflict (containee_kind, containee_id) do nothing returning containee_id`.execute(db);
  if (!result.rows.length) throw new Error("placement: this thing moved after the scan. Its later move was kept.");
}

export async function comparePlacementRemove(db: QueryExecutorProvider, thing: EntityRef, expected: PlacementExpectation): Promise<void> {
  if (!expected.container) return;
  const result = await sql`delete from core_placement_placements where ${matches(thing, expected)} returning containee_id`.execute(db);
  if (!result.rows.length) throw new Error("placement: this thing moved after the scan. Its later move was kept.");
}
