// Shared nav-data hook. Reads the org's /modules, groups enabled
// modules by their first dependency (Pillar-E specialisations nest
// under their base), and applies the persisted nav order. Both the
// desktop ModuleNav and the MobileNav render from this so the two
// surfaces never drift.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type OrgModuleListItem } from "../lib/api";
import { applyNavOrder, readNavOrder } from "../lib/nav-order";

export interface NavModules {
  /** Top-level modules, in the user's persisted order. */
  tops: OrgModuleListItem[];
  /** parentModuleName → its enabled specialisation children. */
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
    const firstDep = m.dependencies[0];
    if (firstDep && enabledNames.has(firstDep)) {
      const arr = childrenByParent.get(firstDep) ?? [];
      arr.push(m);
      childrenByParent.set(firstDep, arr);
    } else {
      rawTops.push(m);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tops = useMemo(
    () => applyNavOrder(rawTops, navOrder),
    [rawTops.map((t) => t.name).join("|"), navOrder.join("|")],
  );

  return { tops, childrenByParent, isLoading: modules.isLoading };
}
