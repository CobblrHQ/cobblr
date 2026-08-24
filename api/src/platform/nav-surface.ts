// The nav shape, as the platform hands it to modules.
//
// nav-headings.ts is the data layer the HTTP routes use; this is the same
// capability offered through `platform().nav`, so a module (and therefore the
// assistant, through that module's actions) can group sections rather than
// telling a person which screen to open.
//
// listEntries is the part that makes it usable from a sentence: someone says
// "put Spices and Tea under Kitchen", and nothing in that sentence is an id.

import { meta } from "../db/meta.js";
import {
  addNavMember,
  createNavHeading,
  deleteNavHeading,
  listNavHeadings,
  removeNavMember,
} from "./nav-headings.js";

export const navSurface = {
  async listHeadings(orgId: string) {
    const headings = await listNavHeadings(orgId);
    return headings.map((h) => ({
      id: h.id,
      name: h.name,
      members: h.members.map((m) => ({ target_kind: m.target_kind, target_id: m.target_id })),
    }));
  },

  async createHeading(orgId: string, name: string, icon?: string | null) {
    return createNavHeading({ orgId, name, icon: icon ?? null });
  },

  async addMember(orgId: string, headingId: string, targetKind: string, targetId: string) {
    await addNavMember({ orgId, headingId, targetKind, targetId });
  },

  async removeMember(orgId: string, targetKind: string, targetId: string) {
    await removeNavMember(orgId, targetKind, targetId);
  },

  async deleteHeading(orgId: string, headingId: string) {
    await deleteNavHeading(orgId, headingId);
  },

  /** What can sit under a heading: the workspace's enabled modules and its
   *  instances, each with the label a person sees in the nav. */
  async listEntries(orgId: string) {
    const [mods, instances] = await Promise.all([
      // A row in org_modules IS the enablement — there is no `enabled` column.
      meta.selectFrom("org_modules").select(["module_name"]).where("org_id", "=", orgId).execute(),
      meta
        .selectFrom("workspace_module_instances")
        .select(["instance_name", "display_name", "is_default"])
        .where("org_id", "=", orgId)
        .execute(),
    ]);
    const entries = mods.map((m) => ({
      kind: "module",
      id: m.module_name,
      label: m.module_name,
    }));
    for (const i of instances) {
      // The default instance IS its module's entry, so it is not a separate row.
      if (i.is_default) continue;
      entries.push({ kind: "instance", id: i.instance_name, label: i.display_name ?? i.instance_name });
    }
    return entries;
  },
};
