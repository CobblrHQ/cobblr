// The workspace's rooms, once, for the location rollup that the reserved
// `location` group key means (see view-group-key.ts). Shared by every grouped
// view surface, the full view's renderers and the dashboard's preview, so they
// resolve a row's room from the same tree. A surface that never groups by
// location pays for nothing: the query is off.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { makeAreaResolver } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "./api";

export function useAreaResolver(enabled: boolean) {
  const { activeSlug } = useActiveOrg();
  const locs = useQuery({
    queryKey: ["inventory-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: enabled && !!activeSlug,
    staleTime: 60_000,
  });
  return useMemo(
    () =>
      makeAreaResolver(locs.data?.items ?? [], {
        id: (l) => l.id,
        parentId: (l) => l.parent_id,
        position: () => 0,
        name: (l) => l.name,
        isContainer: (l) => l.kind === "container",
      }),
    [locs.data],
  );
}
