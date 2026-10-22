// Who may delete a record of a kind: one rule, the kind's own (#7922).
//
// A member was offered "Delete this part", confirmed it, and was told only an
// owner, an admin or an editor may (#7888); an assistant asked to delete the
// same part held it for that member, whose card then failed on "Delete it"
// (#7909). Each asker guessed the rule, and the route alone knew it. Now a
// kind declares it beside its deleteEndpoint (`deleteBy`: a role floor or a
// capability), and every asker reads it here: the kernel door every DELETE
// passes (withTenant), before an assistant's delete is held for a person;
// /entity-kinds, which tells each viewer can_delete; and through those, the
// record's buttons and the assistant's delete_record.

import { platform } from "@cobblr/platform-contract";
import { roleHoldsEveryCapability, roleRefusal, roleSatisfies, ORG_ROLES, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { listEntries } from "../modules/registry.js";

export interface DeleteAsker {
  orgId: string;
  userId: string;
  role: string;
}

interface DeletableKind {
  id: string;
  module_name: string;
  instance_name?: string | null;
  endpoints?: { delete?: string } | null;
}

const isRole = (rule: string): rule is OrgRoleName => (ORG_ROLES as readonly string[]).includes(rule);

/** The kind's declared rule, or null when it declares no delete. A named
 *  instance's kind is its module's primary kind, and deletes by its rule. */
export function deleteRuleOf(kind: Pick<DeletableKind, "id" | "module_name" | "instance_name">): string | null {
  const entry = listEntries().find((e) => e.manifest.name === kind.module_name);
  const kinds = entry?.manifest.provides?.entityKinds ?? [];
  const decl = kind.instance_name ? kinds.find((k) => k.primary === true) : kinds.find((k) => k.id === kind.id);
  return decl?.deleteEndpoint ? (decl.deleteBy ?? null) : null;
}

/** May this person delete a record of this kind? A kind with no delete
 *  declared answers false: there is nothing to press. */
export async function mayDeleteKind(asker: DeleteAsker, kind: DeletableKind): Promise<boolean> {
  if (!kind.endpoints?.delete) return false;
  const rule = deleteRuleOf(kind);
  if (!rule || asker.role === "guest") return false;
  if (isRole(rule)) return roleSatisfies(asker.role, [rule]);
  if (roleHoldsEveryCapability(asker.role)) return true;
  return platform().auth.userHasCapability({ orgId: asker.orgId, userId: asker.userId, role: asker.role, actionId: rule });
}

/** The refusal a DELETE on this kind gets, in the words its route would use,
 *  or null when it may go on. */
export async function deleteRefusal(asker: DeleteAsker, kind: DeletableKind): Promise<{ code: string; message: string; [k: string]: unknown } | null> {
  if (await mayDeleteKind(asker, kind)) return null;
  const rule = deleteRuleOf(kind);
  if (!rule || isRole(rule)) return { code: "forbidden", message: roleRefusal([rule && isRole(rule) ? rule : "admin"]) };
  const blocked = await platform().auth.describeBlockedCapability({ orgId: asker.orgId, userId: asker.userId, role: asker.role, actionId: rule });
  return { code: "missing_capability", message: blocked.sentence, details: { action_id: rule, your_role: asker.role }, blocked };
}

/** The kind whose declared delete endpoint `rel` (the path under
 *  /api/v1/orgs/<slug>) is, with the record's id, or null. */
export async function kindOfDeletePath(orgId: string, rel: string): Promise<{ kind: DeletableKind; id: string } | null> {
  const kinds = (await platform().entities.listKindsForOrg(orgId)) as DeletableKind[];
  for (const k of kinds) {
    const del = k.endpoints?.delete;
    if (!del) continue;
    const base = k.instance_name ? `/instances/${k.instance_name}` : `/modules/${k.module_name}`;
    const template = `${base}/${del.replace(/^\//, "")}`;
    // RECORD-LINK-OK: matches a DELETE request's API path to recognise the record; it builds no address to show anyone.
    const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace("{id}", "([^/]+)")}/?$`); // lint-allow-detail-substitution: an API delete endpoint turned into a matcher, not a detail route
    const m = rel.match(pattern);
    if (m?.[1]) return { kind: k, id: decodeURIComponent(m[1]) };
  }
  return null;
}
