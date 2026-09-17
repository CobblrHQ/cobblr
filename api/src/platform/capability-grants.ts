// Capability grants: what can be granted, and the grant itself.
//
// Pulled out of the portal route because two doors now write a grant — the
// permissions matrix, and an approved request (approvals.ts) — and the rules
// around a grant (a guest stays read-only, only a grantable capability is
// persisted, the activity trail) must be the same rules whichever door it
// came through. A second copy of "may this person be granted this" would be
// the drift lint:role-gate-shared exists for, one layer up.

import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import { capabilityModule, scopeToWorkspace } from "./grantable-scope.js";
import * as activity from "./activity.js";

// Capabilities that requireCapability() gates check but that aren't
// invokable "actions" in the entity_actions registry yet. Until the
// manifest gains a first-class capability registry, list the
// endpoint-gate caps here so they're grantable + validated alongside
// the registered actions. TODO: fold into a manifest-declared registry.
const ENDPOINT_CAPABILITIES = [
  { action_id: "inventory:create-part", label: "Create parts", description: "Add new parts to inventory." },
  { action_id: "inventory:update-part", label: "Edit parts", description: "Edit existing part fields and counts." },
];

/** The module a capability belongs to, for grouping in the admin UI.
 *  Registered actions know theirs; everything else is namespaced
 *  `<module>:<verb>`, so the prefix is the answer. */
/** Every capability an admin can grant a member: the registered actions
 *  (entity_actions) plus the endpoint-gate caps above. Single source of
 *  truth for both the matrix columns and grant validation.
 *
 *  USER-INVOKABLE ONLY. `user_invokable = false` marks an action that exists
 *  purely for a wire to fire on an event — `assets:update-fields` is the
 *  inbound-telemetry shape (an OBD dongle posts a webhook, a wire sets the
 *  mileage); a human never "does" it, so granting a person permission to it is
 *  meaningless. The entity-actions bar already filters on this flag (migration
 *  20260515-012) and the wires builder deliberately doesn't; this surface is
 *  user-facing, so it does. Without the filter the permission matrix listed the
 *  ENTIRE action registry of every installed module. */
export async function grantableActions(
  orgId?: string,
): Promise<Array<{ action_id: string; label: string; description: string; module: string }>> {
  const registered = await meta
    .selectFrom("entity_actions")
    .select(["id", "label", "description", "module_name"])
    .where("user_invokable", "=", true)
    .orderBy("id")
    .execute();
  const items = registered.map((r) => ({
    action_id: r.id,
    label: r.label,
    description: r.description ?? "",
    module: capabilityModule(r.id, r.module_name),
  }));
  const have = new Set(items.map((a) => a.action_id));
  for (const c of ENDPOINT_CAPABILITIES)
    if (!have.has(c.action_id)) items.push({ ...c, module: capabilityModule(c.action_id) });
  // H2 — per-field read-scope capabilities declared by entity kinds
  // (entity_kinds.field_read_scopes values). Auto-grantable so an admin
  // can assign a "view costs"-style cap from the matrix without any
  // central registry: any module that gates a field makes its
  // capability appear here automatically.
  const gatedKinds = await meta
    .selectFrom("entity_kinds")
    .select(["field_read_scopes"])
    .where("field_read_scopes", "is not", null)
    .execute();
  for (const k of gatedKinds) {
    const scopes = (k.field_read_scopes as Record<string, string> | null) ?? {};
    for (const [field, cap] of Object.entries(scopes)) {
      if (have.has(cap)) continue;
      have.add(cap);
      items.push({
        action_id: cap,
        label: `View ${field}`,
        description: `See the "${field}" field on records that restrict it.`,
        module: capabilityModule(cap),
      });
    }
  }
  // H2 admin-configurable — per-workspace field scopes the admin defined
  // (workspace_field_scopes). Same auto-grantable treatment so a
  // workspace's own "view X" caps show in its matrix.
  if (orgId) {
    const perOrg = await meta
      .selectFrom("workspace_field_scopes")
      .select(["field", "capability"])
      .where("org_id", "=", orgId)
      .execute();
    for (const s of perOrg) {
      if (have.has(s.capability)) continue;
      have.add(s.capability);
      items.push({
        action_id: s.capability,
        label: `View ${s.field}`,
        description: `See the "${s.field}" field (restricted in this workspace).`,
        module: capabilityModule(s.capability),
      });
    }
  }
  return orgId ? await onlyEnabledHere(items, orgId) : items;
}

/** Drop capabilities belonging to a module this WORKSPACE has not enabled.
 *
 *  entity_actions is a cobblr_meta table: it registers what every module loaded
 *  by the SERVER declares, not what any one workspace turned on. So a workspace
 *  that never enabled BrickLink was still offered `bricklink:disassemble-kit`
 *  when creating a role — a permission to do something the workspace cannot do,
 *  named after a product its owner may never have heard of.
 *
 *  Conservative on purpose: a capability is dropped only when its module is one
 *  we can SEE in the registry and the workspace lacks it. Anything we cannot
 *  attribute (platform endpoint gates, field-scope caps, a capability whose id
 *  does not name a loaded module) is kept, because silently hiding a grantable
 *  capability locks an admin out of their own permissions with no error to
 *  explain it. Showing one extra is a wart; hiding one is a bug. */
async function onlyEnabledHere<T extends { module: string }>(
  items: T[],
  orgId: string,
): Promise<T[]> {
  const enabled = new Set(
    (
      await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", orgId)
        .execute()
    ).map((r) => r.module_name),
  );
  return scopeToWorkspace(items, {
    enabled,
    known: new Set(listEntries().map((e) => e.manifest.name)),
  });
}


export type GrantOutcome =
  | { ok: true; grant: { id: string; org_id: string; user_id: string; action_id: string } | null; already: boolean }
  | { ok: false; status: 400 | 403 | 404; code: "not_member" | "guest_read_only" | "unknown_action"; message: string };

/** Grant one capability to one member, with the rules every door shares. */
export async function grantCapability(args: {
  orgId: string;
  userId: string;
  actionId: string;
  grantedBy: string;
}): Promise<GrantOutcome> {
  const member = await meta
    .selectFrom("org_memberships")
    .select(["user_id", "role"])
    .where("org_id", "=", args.orgId)
    .where("user_id", "=", args.userId)
    .executeTakeFirst();
  if (!member) {
    return { ok: false, status: 404, code: "not_member", message: "User isn't a member of this workspace." };
  }
  // A guest is read-only by invariant (auth/capability.ts). Every grantable
  // capability gates a MUTATION, so handing one to a guest quietly makes them
  // a writer the rest of the code still treats as read-only. Refuse it; change
  // their role first if they should be able to act. (audit L-GUESTGRANT)
  if (member.role === "guest") {
    return {
      ok: false,
      status: 403,
      code: "guest_read_only",
      message: "Guests are read-only. Change this person's role before granting a capability.",
    };
  }
  // Don't persist arbitrary action_id strings: a grant for a cap
  // that no gate checks is dead, and it pollutes the matrix.
  if (!(await isGrantable(args.orgId, args.actionId))) {
    return {
      ok: false,
      status: 400,
      code: "unknown_action",
      message: `${args.actionId} is not a grantable capability.`,
    };
  }
  const row = await meta
    .insertInto("workspace_capability_grants")
    .values({
      org_id: args.orgId,
      user_id: args.userId,
      action_id: args.actionId,
      granted_by: args.grantedBy,
    })
    .onConflict((c) => c.columns(["org_id", "user_id", "action_id"]).doNothing())
    .returning(["id", "org_id", "user_id", "action_id"])
    .executeTakeFirst();
  await activity.log({
    orgId: args.orgId,
    userId: args.grantedBy,
    action: "capability_granted",
    ref: { module: null, entityType: "user", entityId: args.userId },
    diff: { action_id: args.actionId },
  });
  return { ok: true, grant: row ?? null, already: !row };
}

/** Is this a capability an admin could grant here? The same list the matrix
 *  shows, so nothing can be asked for that could not be given. */
export async function isGrantable(orgId: string, actionId: string): Promise<boolean> {
  const grantable = await grantableActions(orgId);
  return grantable.some((a) => a.action_id === actionId);
}
