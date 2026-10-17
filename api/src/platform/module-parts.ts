// Module parts: the pieces of one module a workspace has on or off on their
// own (docs/architecture/module-parts.md). The kernel's one rule for whether
// a part is on, read by every door that hides a part's things: the action
// gates, the module list (panels and Cobb's tools), the route gate and the
// workspace tools.
//
// A part that is off hides, never deletes: its records, runs and history stay
// where they are, and turning it back on shows all of it again. A part with
// no row here follows its declared default, which is computed, not stored, so
// a part added to a module changes nothing for an existing workspace and no
// boot pass has to write anything for it.
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import type { ModulePart } from "@cobblr/platform-contract";
import { bumpWorkspaceShape } from "./workspace-shape.js";

export interface PartState extends ModulePart { module: string; on: boolean; chosen: boolean }

/** The owner key a part's things carry: `<module>/<part>`. */
export const partOwner = (module: string, part: string) => `${module}/${part}`;

function declaredParts(): Array<{ module: string; part: ModulePart }> {
  return listEntries().flatMap((e) => (e.manifest.parts ?? []).map((part) => ({ module: e.manifest.name, part })));
}

/** Every declared part of the workspace's enabled modules, on or off here. */
export async function partStates(orgId: string, enabledModules?: ReadonlySet<string>): Promise<PartState[]> {
  const parts = declaredParts();
  if (parts.length === 0) return [];
  const on = enabledModules ?? new Set((await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map((r) => r.module_name));
  const relevant = parts.filter((p) => on.has(p.module));
  if (relevant.length === 0) return [];
  const chosen = new Map((await meta.selectFrom("org_module_parts").select(["module_name", "part", "enabled"]).where("org_id", "=", orgId).execute()).map((r) => [partOwner(r.module_name, r.part), r.enabled]));
  const wanted = [...new Set(relevant.flatMap((p) => p.part.collections))];
  const have = wanted.length
    ? new Set((await meta.selectFrom("workspace_module_instances").select("instance_name").where("org_id", "=", orgId).where("instance_name", "in", wanted).execute()).map((r) => r.instance_name))
    : new Set<string>();
  return relevant.map(({ module, part }) => {
    const choice = chosen.get(partOwner(module, part.id));
    const fallback = part.default === "on" || (part.default === "with-collection" && part.collections.some((c) => have.has(c)));
    return { ...part, module, on: choice ?? fallback, chosen: choice !== undefined };
  });
}

/** The owner keys of what is on here: every enabled module, and `<module>/<part>`
 *  for each of its parts that is on. An action, panel or tool with a part is
 *  shown only when its part's key is in this set. */
export async function enabledOwnersWithParts(orgId: string, modules: ReadonlySet<string>): Promise<Set<string>> {
  const out = new Set(modules);
  for (const p of await partStates(orgId, modules)) if (p.on) out.add(partOwner(p.module, p.id));
  return out;
}

/** The part an action belongs to, from its module's manifest. */
export function actionPart(actionId: string): { module: string; part: string } | null {
  for (const e of listEntries()) {
    const a = (e.manifest.exposes?.actions ?? []).find((x) => x.id === actionId);
    if (a) return a.part ? { module: e.manifest.name, part: a.part } : null;
  }
  return null;
}

const prefixMatchers = new Map<string, RegExp>();

/** Whether a request path is under a declared prefix, by the router's own
 *  rule: Express mounts `/arms` as `/^\/arms\/?(?=\/|$)/i`, so `/ARMS/1` and
 *  `/arms/` reach the handlers too. A gate that matched exactly would be off
 *  for one spelling of a route the application still serves. */
export function routeIsUnder(prefix: string, path: string): boolean {
  let re = prefixMatchers.get(prefix);
  if (!re) {
    re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?(?=\\/|$)`, "i");
    prefixMatchers.set(prefix, re);
  }
  return re.test(path);
}

/** The part a module route belongs to, by the part's declared prefixes. */
export function routePart(module: string, path: string): ModulePart | null {
  const m = listEntries().find((e) => e.manifest.name === module)?.manifest;
  return m?.parts.find((p) => p.routes.some((r) => routeIsUnder(r, path))) ?? null;
}

export async function partIsOn(orgId: string, module: string, part: string): Promise<boolean> {
  return (await partStates(orgId, new Set([module]))).find((p) => p.module === module && p.id === part)?.on ?? false;
}

/** Turn a part on or off for the workspace. Data is never touched. */
export async function setPart(orgId: string, module: string, part: string, enabled: boolean, userId: string | null): Promise<PartState> {
  const declared = declaredParts().find((p) => p.module === module && p.part.id === part);
  if (!declared) throw new PartRefusal(`There is no part "${part}" of that app.`);
  await meta.insertInto("org_module_parts").values({ org_id: orgId, module_name: module, part, enabled, updated_by: userId })
    .onConflict((oc) => oc.columns(["org_id", "module_name", "part"]).doUpdateSet({ enabled, updated_by: userId, updated_at: new Date() })).execute();
  await bumpWorkspaceShape(orgId);
  return (await partStates(orgId, new Set([module]))).find((p) => p.id === part)!;
}

/** Forget the workspace's choice: the part follows its default again. */
export async function clearPart(orgId: string, module: string, part: string): Promise<void> {
  await meta.deleteFrom("org_module_parts").where("org_id", "=", orgId).where("module_name", "=", module).where("part", "=", part).execute();
  await bumpWorkspaceShape(orgId);
}

/** The sentence for a part that is off here, in words: never an id. */
export function partOffRefusal(what: string, module: string, part: string): string {
  const m = listEntries().find((e) => e.manifest.name === module)?.manifest;
  const label = m?.parts.find((p) => p.id === part)?.label ?? part;
  return `${what} is part of ${label} in ${m?.displayName ?? module}, which is not turned on in this workspace. A workspace owner or admin can turn it on in Configuration → Modules.`;
}

export class PartRefusal extends Error {}
