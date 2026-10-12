// Which bundle-owned fields get the role their bundle's manifest declares
// (bundle-field-roles.ts), apart from the database so a test can hold it.

export interface OwnedFieldDef {
  id: string;
  bundle_id: string;
  name: string;
  field_role: string | null;
}

/** Every field def a manifest ships, wherever it nests them, by name → the
 *  one role it declares. A name declared with two different roles is left out:
 *  which kind it meant cannot be told from the name. */
export function manifestRolesByName(manifest: unknown): Map<string, string> {
  return manifestDeclaredByName(manifest, "field_role");
}

/** Every field def a manifest ships, by name → the one value it declares for
 *  `key` (field_role, fact_scope). A name declared two ways is left out. */
export function manifestDeclaredByName(manifest: unknown, key: "field_role" | "fact_scope"): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.name === "string" && typeof o.entity_kind === "string" && typeof o.type === "string") {
      const role = typeof o[key] === "string" && o[key] ? (o[key] as string) : "";
      seen.set(o.name, (seen.get(o.name) ?? new Set()).add(role));
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(manifest);
  const out = new Map<string, string>();
  for (const [name, roles] of seen) {
    const declared = [...roles].filter(Boolean);
    if (declared.length === 1 && roles.size === 1) out.set(name, declared[0]!);
  }
  return out;
}

/** The roles to fill. Pure. `bundles` maps an installed bundle's id to its
 *  external id; `catalog` maps an external id to the manifest this image ships. */
export function planFieldRoleHeals(
  defs: readonly OwnedFieldDef[],
  bundles: ReadonlyMap<string, string>,
  catalog: ReadonlyMap<string, unknown>,
): Array<{ id: string; field_role: string }> {
  const rolesFor = new Map<string, Map<string, string>>();
  const out: Array<{ id: string; field_role: string }> = [];
  for (const d of defs) {
    if (d.field_role) continue;
    const external = bundles.get(d.bundle_id);
    if (!external) continue;
    const manifest = catalog.get(external);
    if (!manifest) continue;
    if (!rolesFor.has(external)) rolesFor.set(external, manifestRolesByName(manifest));
    const role = rolesFor.get(external)!.get(d.name);
    if (role) out.push({ id: d.id, field_role: role });
  }
  return out;
}

/** The fact scopes to fill (#6013): a bundle-owned field with none takes the
 *  one its bundle's manifest declares for it. Pure. */
export function planFactScopeHeals(
  defs: ReadonlyArray<{ id: string; bundle_id: string; name: string; fact_scope: string | null }>,
  bundles: ReadonlyMap<string, string>,
  catalog: ReadonlyMap<string, unknown>,
): Array<{ id: string; fact_scope: string }> {
  const scopesFor = new Map<string, Map<string, string>>();
  const out: Array<{ id: string; fact_scope: string }> = [];
  for (const d of defs) {
    if (d.fact_scope) continue;
    const external = bundles.get(d.bundle_id);
    const manifest = external ? catalog.get(external) : undefined;
    if (!external || !manifest) continue;
    if (!scopesFor.has(external)) scopesFor.set(external, manifestDeclaredByName(manifest, "fact_scope"));
    const scope = scopesFor.get(external)!.get(d.name);
    if (scope) out.push({ id: d.id, fact_scope: scope });
  }
  return out;
}
