// Shared nav-data hook. Reads the org's /modules + /bundles, groups
// enabled modules by their first dependency, and merges in lens
// bundles (manifests with `provides_lens`) as synthetic specialisation
// children. Both ModuleNav and MobileNav render from this so the two
// surfaces never drift.
//
// Lens bundles: a bundle with provides_lens.entity_kind = "X:Y"
// renders under the module that owns X (so "machines:machine" lens
// chips nest under the Machines top-level entry). This replaces the
// previous pattern of declaring a Pillar-E module with
// `dependencies: ["machines"]` — see web/src/lib/featured-bundles.ts
// for the 3D Printers / Laser Cutters / CNC Machines / Workshop Mods
// bundles that used to be modules.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type EntityKindOverride,
  type ModuleInstance,
  type OrgModuleListItem,
} from "../lib/api";
import { applyNavOrder, readNavOrder } from "../lib/nav-order";

export interface NavModules {
  /** Top-level modules, in the user's persisted order. */
  tops: OrgModuleListItem[];
  /** parentModuleName → its enabled specialisation children
   *  (either real Pillar-E modules OR installed lens bundles
   *  rendered as synthetic module items). */
  childrenByParent: Map<string, OrgModuleListItem[]>;
  isLoading: boolean;
}

export function useNavModules(activeSlug: string): NavModules {
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // Installed bundles with provides_lens contribute lens children
  // alongside real Pillar-E modules. Cheap because the existing
  // /bundles GET already returns the manifest blob.
  const bundles = useQuery({
    queryKey: ["bundles", activeSlug],
    queryFn: () => api.listBundles(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // Workspace presentation overrides + non-default instances. The
  // overrides change how each nav row renders (label / icon / hidden
  // / order); non-default instances add new top-level entries.
  const overrides = useQuery({
    queryKey: ["entity-kind-overrides", activeSlug],
    queryFn: () => api.listOverrides(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const instances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });

  // Re-read persisted nav order whenever the picker writes one.
  const [navOrder, setNavOrder] = useState<string[]>(() => readNavOrder(activeSlug));
  useEffect(() => {
    setNavOrder(readNavOrder(activeSlug));
    function reload() {
      setNavOrder(readNavOrder(activeSlug));
    }
    window.addEventListener("cobblr:nav-order-changed", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("cobblr:nav-order-changed", reload);
      window.removeEventListener("storage", reload);
    };
  }, [activeSlug]);

  const items = modules.data?.items ?? [];
  const enabled = items.filter((m) => m.enabled);
  const enabledNames = new Set(enabled.map((m) => m.name));

  // Build a lookup of overrides keyed by `<target_kind>:<target_id>`
  // so apply-overrides below is O(1) per entry.
  const overridesByKey = new Map<string, EntityKindOverride>();
  for (const o of overrides.data?.items ?? []) {
    overridesByKey.set(`${o.target_kind}:${o.target_id}`, o);
  }
  function applyEntityKindOverride<T extends { name: string; displayName: string }>(m: T): T & { hidden: boolean; navOrder: number | null } {
    // Apply override for the module's default entity kind (e.g.,
    // assets:asset for assets module). Entity-kind override applies
    // to the kind ID; the module name -> kind ID mapping is one-of
    // (`<module>:<entity>`) but we don't know the entity name here,
    // so fall back to overriding by instance:<module>:<module> for
    // default instances.
    const o = overridesByKey.get(`instance:${m.name}:${m.name}`);
    if (!o) return { ...m, hidden: false, navOrder: null };
    return {
      ...m,
      displayName: o.display_label ?? m.displayName,
      hidden: o.hidden,
      navOrder: o.nav_order,
    };
  }
  // Hide platform-utility modules from the top-level nav. They have
  // routes + pages, but those live under /configuration (and as
  // inline UI like EntityAttachments / SearchBar) — not as peer-
  // level entries alongside "machines" or "inventory". A name
  // starting with `core-` is by convention a foundational /
  // utility module; user-facing modules don't use that prefix.
  const userFacing = enabled.filter((m) => !m.name.startsWith("core-"));
  const childrenByParent = new Map<string, OrgModuleListItem[]>();
  const rawTops: OrgModuleListItem[] = [];
  for (const m of userFacing) {
    const withOverride = applyEntityKindOverride(m);
    if (withOverride.hidden) continue;
    const firstDep = m.dependencies[0];
    if (firstDep && enabledNames.has(firstDep)) {
      const arr = childrenByParent.get(firstDep) ?? [];
      arr.push(withOverride);
      childrenByParent.set(firstDep, arr);
    } else {
      rawTops.push(withOverride);
    }
  }

  // Non-default instances → synthetic top-level nav entries.
  // Default instance (instance_name == module_name) is already
  // represented by the module's own entry above; user-created
  // instances get their own peer row.
  for (const inst of instances.data?.items ?? []) {
    if (inst.is_default) continue;
    const key = `instance:${inst.module_name}:${inst.instance_name}`;
    const o = overridesByKey.get(key);
    if (o?.hidden) continue;
    const display = o?.display_label ?? inst.display_name;
    const synth: OrgModuleListItem & { _instance?: ModuleInstance } = {
      name: `__instance__${inst.instance_name}`,
      version: "0.1.0",
      displayName: display,
      description: `Instance of ${inst.module_name}`,
      icon: o?.icon ?? null,
      dependencies: [],
      contributes: { fieldDefs: 0, wires: 0 },
      enabled: true,
      enabled_version: "0.1.0",
      enabled_at: inst.created_at,
      _instance: inst,
    };
    rawTops.push(synth);
  }
  // Lens bundles → synthetic OrgModuleListItem entries under the
  // module that owns their entity_kind. entity_kind "machines:machine"
  // → parent module "machines"; the part before ':' is the module
  // name by convention.
  for (const b of bundles.data?.items ?? []) {
    const lens = b.manifest?.provides_lens;
    if (!lens) continue;
    const parent = lens.entity_kind.split(":")[0];
    if (!parent || !enabledNames.has(parent)) continue;
    const synth: OrgModuleListItem = {
      name: lens.name,
      version: b.version,
      displayName: lens.display_name,
      description: b.description ?? "",
      icon: null,
      dependencies: [parent],
      contributes: { fieldDefs: b.manifest?.field_defs?.length ?? 0, wires: 0 },
      enabled: true,
      enabled_version: b.version,
      enabled_at: b.installed_at,
    };
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(synth);
    childrenByParent.set(parent, arr);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tops = useMemo(
    () => applyNavOrder(rawTops, navOrder),
    [rawTops.map((t) => t.name).join("|"), navOrder.join("|")],
  );

  return {
    tops,
    childrenByParent,
    isLoading: modules.isLoading || bundles.isLoading,
  };
}
