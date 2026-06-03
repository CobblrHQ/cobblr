// Nav-builder #2 — user-defined navbar headings (org-wide). A workspace
// groups nav entries (modules + instances) under custom headings,
// cross-module. CRUD service over the cobblr_meta tables; the web nav
// renderer folds these into the dropdown tree (reusing ModuleGroupChip).
//
// See docs/architecture/nav-builder.md.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

export interface NavHeadingMember {
  target_kind: string; // 'module' | 'instance'
  target_id: string;
  position: number;
}
export interface NavHeading {
  id: string;
  org_id: string;
  name: string;
  icon: string | null;
  position: number;
  members: NavHeadingMember[];
}

export async function listNavHeadings(orgId: string): Promise<NavHeading[]> {
  const headings = await meta
    .selectFrom("workspace_nav_headings")
    .select(["id", "org_id", "name", "icon", "position"])
    .where("org_id", "=", orgId)
    .orderBy("position")
    .orderBy("created_at")
    .execute();
  const members = headings.length
    ? await meta
        .selectFrom("workspace_nav_heading_members")
        .select(["heading_id", "target_kind", "target_id", "position"])
        .where("org_id", "=", orgId)
        .orderBy("position")
        .execute()
    : [];
  const byHeading = new Map<string, NavHeadingMember[]>();
  for (const m of members) {
    const arr = byHeading.get(m.heading_id) ?? [];
    arr.push({ target_kind: m.target_kind, target_id: m.target_id, position: m.position });
    byHeading.set(m.heading_id, arr);
  }
  return headings.map((h) => ({
    id: h.id,
    org_id: h.org_id,
    name: h.name,
    icon: h.icon,
    position: h.position,
    members: byHeading.get(h.id) ?? [],
  }));
}

export async function createNavHeading(args: {
  orgId: string;
  name: string;
  icon?: string | null;
}): Promise<{ id: string }> {
  // Append to the end (max position + 1).
  const max = await meta
    .selectFrom("workspace_nav_headings")
    .select(meta.fn.max<number>("position").as("m"))
    .where("org_id", "=", args.orgId)
    .executeTakeFirst();
  const row = await meta
    .insertInto("workspace_nav_headings")
    .values({
      org_id: args.orgId,
      name: args.name,
      icon: args.icon ?? null,
      position: (Number(max?.m ?? -1)) + 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function updateNavHeading(
  orgId: string,
  id: string,
  patch: { name?: string; icon?: string | null; position?: number },
): Promise<boolean> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.position !== undefined) set.position = patch.position;
  const r = await meta
    .updateTable("workspace_nav_headings")
    .set(set as never)
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

export async function deleteNavHeading(orgId: string, id: string): Promise<void> {
  // Members cascade via FK; the entries simply return to their default
  // nav position (top-level / under their module).
  await meta
    .deleteFrom("workspace_nav_headings")
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .execute();
}

/** Add an entry to a heading. An entry lives in at most one heading per
 *  workspace, so this first detaches it from any other heading. */
export async function addNavMember(args: {
  orgId: string;
  headingId: string;
  targetKind: string;
  targetId: string;
}): Promise<void> {
  await meta
    .deleteFrom("workspace_nav_heading_members")
    .where("org_id", "=", args.orgId)
    .where("target_kind", "=", args.targetKind)
    .where("target_id", "=", args.targetId)
    .execute();
  const max = await meta
    .selectFrom("workspace_nav_heading_members")
    .select(meta.fn.max<number>("position").as("m"))
    .where("heading_id", "=", args.headingId)
    .executeTakeFirst();
  await meta
    .insertInto("workspace_nav_heading_members")
    .values({
      heading_id: args.headingId,
      org_id: args.orgId,
      target_kind: args.targetKind,
      target_id: args.targetId,
      position: (Number(max?.m ?? -1)) + 1,
    })
    .execute();
}

export async function removeNavMember(
  orgId: string,
  targetKind: string,
  targetId: string,
): Promise<void> {
  await meta
    .deleteFrom("workspace_nav_heading_members")
    .where("org_id", "=", orgId)
    .where("target_kind", "=", targetKind)
    .where("target_id", "=", targetId)
    .execute();
}

void sql;
