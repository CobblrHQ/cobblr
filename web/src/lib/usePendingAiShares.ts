// Pending AI-share offers a workspace OWNER still needs to act on. A member can
// route their personal AI to a workspace they don't own ("Share"), but it can't
// power that workspace until the owner approves it — and that pending state was
// easy to miss (in-app bell only, buried settings panel). This is the single
// source of truth for surfacing it OUTSIDE the settings page (dashboard callout
// + nav dot).
//
// The endpoint returns for any member, but only owners can approve — so we only
// fetch when it's actionable. Shares the ["ai-shares", slug] query key with the
// settings panel, so approving in one place updates the other.

import { useQuery } from "@tanstack/react-query";
import { api, type WorkspaceAiOffer } from "./api";

export function usePendingAiShares(slug: string, isOwner: boolean): WorkspaceAiOffer[] {
  const q = useQuery({
    queryKey: ["ai-shares", slug],
    queryFn: () => api.listAiShares(slug),
    enabled: !!slug && isOwner,
    // Poll so a member's new offer surfaces on the dashboard callout without a
    // reload (owner-only, so this only runs for the handful who can act on it).
    refetchInterval: 20_000,
  });
  return (q.data?.items ?? []).filter((o) => o.status === "pending");
}
