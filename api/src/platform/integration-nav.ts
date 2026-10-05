// PERMANENT RECONCILE: integrations live under services, never as collection rows.
// BORN WITH: enableModuleForOrg (uses hideIntegrationNavForOrg when an integration is enabled)
import { meta } from "../db/meta.js";
import { list } from "../modules/registry.js";
import { bumpWorkspaceShape } from "./workspace-shape.js";
import { notePassFailure } from "./pass-failures.js";

export async function hideIntegrationNavForOrg(orgId: string, moduleName: string): Promise<void> {
  await meta.insertInto("entity_kind_overrides").values({
    org_id: orgId, target_kind: "instance", target_id: `${moduleName}:${moduleName}`, hidden: true,
  }).onConflict((oc) => oc.columns(["org_id", "target_kind", "target_id"]).doUpdateSet({ hidden: true })).execute();
}

export async function reconcileIntegrationNav(from: readonly { name: string; integration?: unknown }[] = list()): Promise<number> {
  const names = from.filter((m) => m.integration).map((m) => m.name);
  if (!names.length) return 0;
  const enabled = await meta.selectFrom("org_modules").select(["org_id", "module_name"]).where("module_name", "in", names).execute();
  const hidden = await meta.selectFrom("entity_kind_overrides").select(["org_id", "target_id"]).where("target_kind", "=", "instance").where("hidden", "=", true).execute();
  const done = new Set(hidden.map((r) => `${r.org_id}/${r.target_id}`));
  let healed = 0;
  for (const row of enabled) {
    if (done.has(`${row.org_id}/${row.module_name}:${row.module_name}`)) continue;
    try {
      await hideIntegrationNavForOrg(row.org_id, row.module_name);
      await bumpWorkspaceShape(row.org_id);
      healed++;
    } catch (error) { notePassFailure("reconcileIntegrationNav", row.org_id, error); console.error(`[reconcile] integration navigation for ${row.org_id}:`, error); }
  }
  return healed;
}
