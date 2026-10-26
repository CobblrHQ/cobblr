import { platform } from "@cobblr/platform-contract";
import { createCapabilityForKind, createCapabilityForModule } from "@cobblr/platform-contract/create-capability";
import { roleRefusal, roleSatisfies } from "@cobblr/platform-contract/org-roles";

export async function createRefusal(
  asker: { orgId: string; userId: string; role: string },
  kind: { id: string; module_name: string; instance_name?: string | null },
): Promise<string | null> {
  if (!roleSatisfies(asker.role, ["member"])) return roleRefusal(["member"]);
  const actionId = kind.instance_name ? createCapabilityForModule(kind.module_name) : createCapabilityForKind(kind.id);
  if (!actionId || await platform().auth.userHasCapability({ ...asker, actionId })) return null;
  return (await platform().auth.describeBlockedCapability({ ...asker, actionId })).sentence;
}
