// The Live box aggregation (docs/design-decisions/live-controls.md §3-4). Modules
// register capability evaluators (`printer.connected`, `scanner.bridge`, …);
// applicable() returns, for a workspace, every ENABLED module's exposes.live
// control whose `requires` capability is satisfied right now. Empty array → the
// box self-hides. The box is a dumb renderer of whatever this returns.

import type { LiveControlPublic } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";

type Evaluator = (orgId: string) => Promise<boolean>;

const capabilities = new Map<string, Evaluator>();

/** A module registers a capability signal a live control gates on. Idempotent by
 *  name (last registration wins). */
export function registerCapability(name: string, evaluate: Evaluator): void {
  capabilities.set(name, evaluate);
}

export async function applicable(orgId: string): Promise<LiveControlPublic[]> {
  // Enabled modules for this workspace (row exists ⇔ enabled).
  const enabled = new Set(
    (
      await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", orgId)
        .execute()
    ).map((r) => r.module_name),
  );

  const declared: LiveControlPublic[] = [];
  for (const { manifest } of listEntries()) {
    if (!enabled.has(manifest.name)) continue;
    for (const lc of manifest.exposes?.live ?? []) declared.push({ ...lc, module: manifest.name });
  }
  if (declared.length === 0) return [];

  // Evaluate each DISTINCT capability at most once per call (cheap + cached). A
  // missing evaluator or a throwing one reads as "not satisfied" so a control
  // never appears on a capability nobody vouches for.
  const cache = new Map<string, Promise<boolean>>();
  const satisfied = (name: string): Promise<boolean> => {
    let p = cache.get(name);
    if (!p) {
      const evaluate = capabilities.get(name);
      p = evaluate ? evaluate(orgId).catch(() => false) : Promise.resolve(false);
      cache.set(name, p);
    }
    return p;
  };

  const out: LiveControlPublic[] = [];
  for (const c of declared) if (await satisfied(c.requires)) out.push(c);
  return out.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}
