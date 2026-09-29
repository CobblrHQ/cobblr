// Which account settings this deployment offers yet (account-nav onlyWhen).
// A setting that ships dark stays out of the hub until the server says so.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { AccountFeature } from "./account-nav";

export function useOfferedAccountFeatures(): ReadonlySet<AccountFeature> {
  const photos = useQuery({ queryKey: ["photo-consent"], queryFn: () => api.mePhotoConsent(), staleTime: 5 * 60_000 });
  return useMemo(() => new Set<AccountFeature>(photos.data?.available ? ["photo-consent"] : []), [photos.data?.available]);
}
