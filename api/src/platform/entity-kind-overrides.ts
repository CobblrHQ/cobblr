// Workspace presentation overrides — the registry of "things visible
// in the nav and how they look." Both lens-promotion and instance
// creation write rows here; the nav renderer + breadcrumb + heading
// + search-chip read from it.
//
// See docs/architecture/instances.md §3.2 + lens-promotion.md §1.0.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

export type OverrideTarget = "entity_kind" | "instance" | "bundle";

export interface EntityKindOverride {
  id: string;
  org_id: string;
  target_kind: OverrideTarget;
  target_id: string;
  display_label: string | null;
  display_label_plural: string | null;
  icon: string | null;
  hidden: boolean;
  nav_order: number | null;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface OverrideUpsertArgs {
  orgId: string;
  targetKind: OverrideTarget;
  targetId: string;
  displayLabel?: string | null;
  displayLabelPlural?: string | null;
  icon?: string | null;
  hidden?: boolean;
  navOrder?: number | null;
  config?: Record<string, unknown>;
  /** When true, only insert if no row exists for (orgId, targetKind,
   *  targetId). Used by bundle install to seed *initial* values
   *  without clobbering workspace edits. */
  insertOnly?: boolean;
}

/** Insert or update an override row. `insertOnly: true` skips updates
 *  on conflict — bundles' default values land once and never overwrite
 *  workspace edits. */
export async function upsertOverride(args: OverrideUpsertArgs): Promise<EntityKindOverride> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (args.displayLabel !== undefined) set.display_label = args.displayLabel;
  if (args.displayLabelPlural !== undefined) set.display_label_plural = args.displayLabelPlural;
  if (args.icon !== undefined) set.icon = args.icon;
  if (args.hidden !== undefined) set.hidden = args.hidden;
  if (args.navOrder !== undefined) set.nav_order = args.navOrder;
  if (args.config !== undefined) {
    set.config = sql`${JSON.stringify(args.config)}::jsonb` as never;
  }

  if (args.insertOnly) {
    // Insert; on conflict do nothing. Returns the existing row even
    // if no insert happened.
    await meta
      .insertInto("entity_kind_overrides")
      .values({
        org_id: args.orgId,
        target_kind: args.targetKind,
        target_id: args.targetId,
        display_label: args.displayLabel ?? null,
        display_label_plural: args.displayLabelPlural ?? null,
        icon: args.icon ?? null,
        hidden: args.hidden ?? false,
        nav_order: args.navOrder ?? null,
        config: args.config
          ? (sql`${JSON.stringify(args.config)}::jsonb` as never)
          : (sql`'{}'::jsonb` as never),
      })
      .onConflict((c) => c.columns(["org_id", "target_kind", "target_id"]).doNothing())
      .execute();
    const existing = await meta
      .selectFrom("entity_kind_overrides")
      .selectAll()
      .where("org_id", "=", args.orgId)
      .where("target_kind", "=", args.targetKind)
      .where("target_id", "=", args.targetId)
      .executeTakeFirstOrThrow();
    return existing as EntityKindOverride;
  }

  return (await meta
    .insertInto("entity_kind_overrides")
    .values({
      org_id: args.orgId,
      target_kind: args.targetKind,
      target_id: args.targetId,
      display_label: args.displayLabel ?? null,
      display_label_plural: args.displayLabelPlural ?? null,
      icon: args.icon ?? null,
      hidden: args.hidden ?? false,
      nav_order: args.navOrder ?? null,
      config: args.config
        ? (sql`${JSON.stringify(args.config)}::jsonb` as never)
        : (sql`'{}'::jsonb` as never),
    })
    .onConflict((c) =>
      c.columns(["org_id", "target_kind", "target_id"]).doUpdateSet(set as never),
    )
    .returningAll()
    .executeTakeFirstOrThrow()) as EntityKindOverride;
}

/** One override row's config blob (e.g. an instance's item_noun/qty_unit,
 *  written by bundle install) — {} when no override exists. */
export async function getOverrideConfig(
  orgId: string,
  targetKind: OverrideTarget,
  targetId: string,
): Promise<Record<string, unknown>> {
  const row = (await meta
    .selectFrom("entity_kind_overrides")
    .select("config")
    .where("org_id", "=", orgId)
    .where("target_kind", "=", targetKind)
    .where("target_id", "=", targetId)
    .executeTakeFirst()) as { config: Record<string, unknown> | null } | undefined;
  return row?.config ?? {};
}

/** List every override row for a workspace. */
export async function listOverrides(orgId: string): Promise<EntityKindOverride[]> {
  return (await meta
    .selectFrom("entity_kind_overrides")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("nav_order", "asc")
    .orderBy("target_kind", "asc")
    .orderBy("target_id", "asc")
    .execute()) as EntityKindOverride[];
}

/** Delete an override row (resets to manifest defaults at render time). */
export async function deleteOverride(
  orgId: string,
  targetKind: OverrideTarget,
  targetId: string,
): Promise<void> {
  await meta
    .deleteFrom("entity_kind_overrides")
    .where("org_id", "=", orgId)
    .where("target_kind", "=", targetKind)
    .where("target_id", "=", targetId)
    .execute();
}
