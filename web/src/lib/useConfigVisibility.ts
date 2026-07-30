// The ONE place that answers "which settings destinations can this person, in
// this workspace, actually use?" — shared by the /configuration hub, the
// section pages, the settings sidebar and the ⌘K feature index, so all four
// hide exactly the same things.
//
// Before the 2026-07 revamp nothing filtered: every workspace saw every
// destination. On a workspace without digifab / core-print, those tiles led to
// pages whose API routes are not mounted, so opening one 409'd. See
// docs/design-decisions/configuration-revamp.md.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import type { VisibilityContext } from "./configuration-nav";

export function useConfigVisibility(): VisibilityContext {
  const { activeSlug, activeOrg } = useActiveOrg();
  // Shares the cached ["org-modules"] query the nav already fetches, so this
  // costs no extra request.
  const modulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const items = modulesQ.data?.items;
  return {
    // null while loading — nothing is module-hidden yet, so the settings area
    // never flickers entries in as the query resolves.
    enabledModules: items
      ? new Set(items.filter((m) => m.enabled).map((m) => m.name))
      : null,
    role: activeOrg?.role ?? null,
  };
}
