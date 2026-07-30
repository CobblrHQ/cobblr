// Hosted-overlay settings panels (billing, Slack, QuickBooks, …) contributed at
// runtime by the closed cloud overlay. Open core registers none, so this is []
// on a self-hosted instance and the Cloud section never renders — none of the
// panels' names or logic ship in core.
//
// Each panel renders through the generic HostedPanelPage at /configuration/x/:id.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export interface HostedPanel {
  id: string;
  label: string;
  icon?: string;
  /** Pre-2026-07 group id. Ignored for placement — every hosted panel lives in
   *  the Cloud section now (see sectionForHostedPanel) — but kept on the type
   *  because the overlay still sends it. */
  group?: string;
}

export function useHostedPanels(): { panels: HostedPanel[]; isLoading: boolean } {
  const { activeSlug } = useActiveOrg();
  const q = useQuery({
    queryKey: ["hosted-panels", activeSlug],
    queryFn: () =>
      api.request<{ panels: HostedPanel[] }>("GET", `/orgs/${activeSlug}/hosted-panels`),
    enabled: !!activeSlug,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return { panels: q.data?.panels ?? [], isLoading: q.isLoading };
}
