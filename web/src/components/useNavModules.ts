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
import { readNavHidden, readNavOrder } from "../lib/nav-order";

/** Synthetic top-level name prefix for a user-defined heading group. */
export const HEADING_PREFIX = "__heading__";

export interface NavModules {
  /** Top-level modules the user sees — ordered + with per-device hidden
   *  entries removed. */
  tops: OrgModuleListItem[];
  /** Every candidate top-level entry (ordered) INCLUDING ones the user
   *  has hidden — the navbar customize control needs the full set so it
   *  can offer to re-show them. */
  allTops: OrgModuleListItem[];
  /** Names the user has hidden from their nav (per-device). */
  hiddenNames: Set<string>;
  /** parentModuleName → its enabled specialisation children
   *  (either real Pillar-E modules OR installed lens bundles
   *  rendered as synthetic module items). */
  childrenByParent: Map<string, OrgModuleListItem[]>;
  /** Every enabled module name (including `core-*`). Lets the nav gate
   *  hardcoded affordances like the scan link on their module being on
   *  — a blank slate shows only what the user has turned on. */
  enabledNames: Set<string>;
  isLoading: boolean;
}

/** A multi-instance module's auto-created default instance is the module's own
 *  top-level nav entry. Once the workspace has NAMED instances, an EMPTY default
 *  is clutter the user never created — so hide the module's entry when it has a
 *  named instance AND its default holds 0 items. count === null (module reports
 *  no count) or > 0 → keep it (never hide live data). Pure for testability. */
export function defaultModuleEntriesToHide(instances: ModuleInstance[]): Set<string> {
  const byModule = new Map<string, ModuleInstance[]>();
  for (const inst of instances) {
    const arr = byModule.get(inst.module_name) ?? [];
    arr.push(inst);
    byModule.set(inst.module_name, arr);
  }
  const hide = new Set<string>();
  for (const [moduleName, insts] of byModule) {
    const def = insts.find((i) => i.is_default);
    const hasNamed = insts.some((i) => !i.is_default);
    if (hasNamed && def && def.item_count === 0) hide.add(moduleName);
  }
  return hide;
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
  // User-defined headings (#2b) — group nav entries under custom
  // dropdowns. Org-wide; folded into childrenByParent below.
  const headings = useQuery({
    queryKey: ["nav-headings", activeSlug],
    queryFn: () => api.listNavHeadings(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });

  // Re-read persisted nav order + hidden set whenever they change.
  const [navOrder, setNavOrder] = useState<string[]>(() => readNavOrder(activeSlug));
  const [navHidden, setNavHidden] = useState<string[]>(() => readNavHidden(activeSlug));
  useEffect(() => {
    setNavOrder(readNavOrder(activeSlug));
    setNavHidden(readNavHidden(activeSlug));
    function reload() {
      setNavOrder(readNavOrder(activeSlug));
      setNavHidden(readNavHidden(activeSlug));
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
  function applyEntityKindOverride<T extends { name: string; displayName: string }>(m: T): T & { hidden: boolean; navOrder: number | null; groupLabel: string | null } {
    // Apply override for the module's default entity kind (e.g.,
    // assets:asset for assets module). Entity-kind override applies
    // to the kind ID; the module name -> kind ID mapping is one-of
    // (`<module>:<entity>`) but we don't know the entity name here,
    // so fall back to overriding by instance:<module>:<module> for
    // default instances.
    const o = overridesByKey.get(`instance:${m.name}:${m.name}`);
    if (!o) return { ...m, hidden: false, navOrder: null, groupLabel: null };
    return {
      ...m,
      displayName: o.display_label ?? m.displayName,
      hidden: o.hidden,
      navOrder: o.nav_order,
      // Custom heading for this module's specialisations/instances
      // dropdown (ModuleGroupChip reads it; falls back to the default
      // "<module> specialisations").
      groupLabel: (o.config?.group_label as string | undefined) ?? null,
    };
  }
  // Hide platform-utility modules from the top-level nav. They have
  // routes + pages, but those live under /configuration (and as
  // inline UI like EntityAttachments / SearchBar) — not as peer-
  // level entries alongside "machines" or "inventory". A name
  // starting with `core-` is by convention a foundational /
  // utility module; user-facing modules don't use that prefix. We also exclude
  // band:"foundational" by manifest — operator plumbing like `cobblr-cloud` (the
  // hosted overlay) isn't core-prefixed but is still not a user-facing nav noun.
  const userFacing = enabled.filter(
    (m) => !m.name.startsWith("core-") && m.band !== "foundational",
  );
  // Hide a multi-instance module's own entry when its auto-created default
  // instance is empty and the workspace has named instances (see helper).
  const hideDefaultModules = defaultModuleEntriesToHide(instances.data?.items ?? []);
  const childrenByParent = new Map<string, OrgModuleListItem[]>();
  const rawTops: OrgModuleListItem[] = [];
  for (const m of userFacing) {
    if (hideDefaultModules.has(m.name)) continue;
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

  // core-scan is a capability (no nav noun by the core-* rule above), but the
  // scan INBOX page needs a discoverable home — the header camera icon now
  // jumps straight to the live scanner, so without this entry there'd be no
  // labelled path to /scan at all. Synthetic top named "scan" → both navs
  // route it to /scan; per-device hide/reorder works because those key on the
  // entry name like any other.
  if (enabledNames.has("core-scan")) {
    rawTops.push({
      name: "scan",
      version: "0.1.0",
      displayName: "Scan Inbox",
      description: "Scan Inbox — review + file barcode/photo intake",
      icon: "scan-line",
      headerAction: null,
      dependencies: [],
      contributes: { fieldDefs: 0, wires: 0 },
      enabled: true,
      enabled_version: "0.1.0",
      enabled_at: "",
    });
  }

  // A non-default instance is a SEPARATE TOP-LEVEL domain by default — per
  // instances.md it's "a new top-level thing to the user, never mixed." So it
  // gets its OWN top-level nav heading ("Pantry"), no dropdown, no trace of the
  // source module's name. The workshop "inventory → types of parts" shape
  // (Screws / Printer-parts nested under inventory, from c050605) is now an
  // OPT-IN per-instance choice: set `config.presents_as_top_level = false` on
  // the instance's presentation override and it nests as a dropdown child of its
  // module instead. (Lenses — sub-categories within a domain — always nest.)
  // The default instance (instance_name == module_name) is the module's own
  // entry, so it's skipped here.
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
      headerAction: null,
      dependencies: [],
      contributes: { fieldDefs: 0, wires: 0 },
      enabled: true,
      enabled_version: "0.1.0",
      enabled_at: inst.created_at,
      _instance: inst,
    };
    // Top-level unless the override explicitly opts into nesting.
    const nestUnderModule =
      o?.config?.presents_as_top_level === false &&
      enabledNames.has(inst.module_name) &&
      !inst.module_name.startsWith("core-");
    if (nestUnderModule) {
      const arr = childrenByParent.get(inst.module_name) ?? [];
      arr.push(synth);
      childrenByParent.set(inst.module_name, arr);
    } else {
      rawTops.push(synth);
    }
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
      headerAction: null,
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

  // Fold user-defined headings (#2b): each heading becomes a synthetic
  // top-level GROUP; its members move out of their default position
  // (top row / under-module) into the heading's dropdown. Instance
  // members move from their module's children; module members move from
  // the top row (their own instance-children flatten in alongside, so
  // nothing is orphaned). The HEADING_PREFIX marks a label-only group
  // (no page of its own).
  for (const h of headings.data?.items ?? []) {
    const hkey = `${HEADING_PREFIX}${h.id}`;
    const hkids: OrgModuleListItem[] = [];
    for (const mem of h.members) {
      if (mem.target_kind === "instance") {
        const childName = `__instance__${mem.target_id}`;
        // Instances are top-level rows now — pull from rawTops first; fall back
        // to a parent's children for any legacy still-nested instance.
        const ti = rawTops.findIndex((t) => t.name === childName);
        if (ti >= 0) {
          hkids.push(rawTops[ti]!);
          rawTops.splice(ti, 1);
        } else {
          for (const [parent, arr] of childrenByParent) {
            const idx = arr.findIndex((c) => c.name === childName);
            if (idx >= 0) {
              hkids.push(arr[idx]!);
              arr.splice(idx, 1);
              childrenByParent.set(parent, arr);
              break;
            }
          }
        }
      } else {
        const idx = rawTops.findIndex((t) => t.name === mem.target_id);
        if (idx >= 0) {
          hkids.push(rawTops[idx]!);
          rawTops.splice(idx, 1);
          const sub = childrenByParent.get(mem.target_id);
          if (sub && sub.length) {
            hkids.push(...sub);
            childrenByParent.delete(mem.target_id);
          }
        }
      }
    }
    if (hkids.length > 0) {
      childrenByParent.set(hkey, hkids);
      rawTops.push({
        name: hkey,
        version: "0.1.0",
        displayName: h.name,
        description: "Heading",
        icon: h.icon,
        headerAction: null,
        dependencies: [],
        contributes: { fieldDefs: 0, wires: 0 },
        enabled: true,
        enabled_version: "0.1.0",
        enabled_at: "",
      });
    }
  }

  // The memo key must include the override-mutable presentation fields —
  // display label, icon, and the specialisations group label — not just
  // the names. Overrides resolve asynchronously; keying on names alone
  // returns the stale pre-override array when they arrive after the first
  // render (a rename / re-icon / heading edit then silently no-ops until
  // a name changes). Including the content makes it deterministic.
  const rawTopsKey = rawTops
    .map((t) => {
      const x = t as OrgModuleListItem & { groupLabel?: string | null; navOrder?: number | null };
      return `${x.name}${x.displayName}${x.icon ?? ""}${x.groupLabel ?? ""}${x.navOrder ?? ""}`;
    })
    .join("|");
  // Order precedence: (1) the member's per-device reorder (localStorage)
  // wins; then (2) the org-wide `nav_order` set in Configuration →
  // Presentation; then (3) alphabetical. Before this, the sort honoured
  // only the per-device order, so the admin "Nav order" field was dead
  // and important modules (e.g. machines) fell to the end alphabetically
  // and overflowed into "more".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allTops = useMemo(() => {
    const pos = new Map(navOrder.map((n, i) => [n, i] as const));
    return [...rawTops].sort((a, b) => {
      const ap = pos.has(a.name) ? pos.get(a.name)! : null;
      const bp = pos.has(b.name) ? pos.get(b.name)! : null;
      if (ap !== null && bp !== null) return ap - bp;
      if (ap !== null) return -1;
      if (bp !== null) return 1;
      const ao = (a as { navOrder?: number | null }).navOrder ?? null;
      const bo = (b as { navOrder?: number | null }).navOrder ?? null;
      if (ao !== null && bo !== null && ao !== bo) return ao - bo;
      if (ao !== null && bo === null) return -1;
      if (bo !== null && ao === null) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [rawTopsKey, navOrder.join("|")]);
  const hiddenNames = new Set(navHidden);
  const tops = allTops.filter((t) => !hiddenNames.has(t.name));

  return {
    tops,
    allTops,
    hiddenNames,
    childrenByParent,
    enabledNames,
    isLoading: modules.isLoading || bundles.isLoading,
  };
}
