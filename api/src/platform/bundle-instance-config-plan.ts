// Which installed tables get a declaration their bundle's manifest gained
// after they were installed (bundle-instance-config.ts), apart from the
// database so a test can hold it.

/** The table-level declarations this fills when an install lacks them. Each
 *  is one a bundle release added that changes what an action does, so an
 *  install from before it would otherwise keep behaving the old way until a
 *  bundle update applied: a Lego set disassembled onto Parts instead of
 *  Bricks (#5434). Only keys a person never sets; a value already there is
 *  never replaced. */
export const HEALED_INSTANCE_KEYS = ["parts_into"] as const;

export interface InstalledBundle {
  org_id: string;
  external_id: string;
}

export interface InstanceOverride {
  org_id: string;
  /** `<module>:<instance_name>` */
  target_id: string;
  config: Record<string, unknown> | null;
}

export interface InstancePatch {
  org_id: string;
  target_id: string;
  patch: Record<string, unknown>;
}

/** Every table a manifest ships, the base ones and each feature's, by
 *  `<module>:<instance_name>` → the declarations this heal fills. */
export function manifestInstanceDeclarations(manifest: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const m = (manifest ?? {}) as { provides_instances?: unknown; features?: unknown };
  const instances = [
    ...(Array.isArray(m.provides_instances) ? m.provides_instances : []),
    ...(Array.isArray(m.features) ? m.features.flatMap((f) => (Array.isArray((f as { provides_instances?: unknown }).provides_instances) ? (f as { provides_instances: unknown[] }).provides_instances : [])) : []),
  ] as Array<Record<string, unknown>>;
  for (const inst of instances) {
    if (typeof inst.module !== "string" || typeof inst.instance_name !== "string") continue;
    const declared: Record<string, unknown> = {};
    for (const k of HEALED_INSTANCE_KEYS) if (inst[k] !== undefined && inst[k] !== null) declared[k] = inst[k];
    if (Object.keys(declared).length) out.set(`${inst.module}:${inst.instance_name}`, declared);
  }
  return out;
}

/** The patches to write. Pure. `catalog` maps a bundle's external id to the
 *  manifest this image ships; `overrides` are the workspaces' installed
 *  tables. Only a table its own workspace's install of the bundle provides
 *  (a feature that is off has no table, so nothing to fill), only a missing
 *  key. */
export function planInstanceConfigHeals(
  installed: readonly InstalledBundle[],
  catalog: ReadonlyMap<string, unknown>,
  overrides: readonly InstanceOverride[],
): InstancePatch[] {
  const byOrgTable = new Map(overrides.map((o) => [`${o.org_id}|${o.target_id}`, o]));
  const out: InstancePatch[] = [];
  for (const b of installed) {
    const declared = manifestInstanceDeclarations(catalog.get(b.external_id));
    for (const [table, keys] of declared) {
      const row = byOrgTable.get(`${b.org_id}|${table}`);
      if (!row) continue;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(keys)) {
        const now = row.config?.[k];
        if (now === undefined || now === null) patch[k] = v;
      }
      if (Object.keys(patch).length) out.push({ org_id: b.org_id, target_id: table, patch });
    }
  }
  return out;
}
