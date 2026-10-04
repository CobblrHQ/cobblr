import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useScanOrigins(slug: string): readonly string[] {
  const modules = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const labelsOn = modules.data?.items.some(module => module.name === "labels" && module.enabled) ?? false;
  const settings = useQuery({
    queryKey: ["qr-settings", slug],
    queryFn: () => api.getQrSettings(slug),
    enabled: !!slug && labelsOn,
  });
  const labelBaseUrl = labelsOn ? settings.data?.label_base_url : null;
  return useMemo(() => [window.location.origin, ...(labelBaseUrl ? [labelBaseUrl] : [])], [labelBaseUrl]);
}
