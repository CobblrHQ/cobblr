// Native-field presentation overrides, read side. A module's entity form
// renders its native fields hardcoded; this hook lets a bundle/config RELABEL
// and SHOW/HIDE them per entity kind (or per instance, since an instance has
// its own kind id). Forms wrap each native field: use `label(name, default)`
// for the label and skip rendering when `hidden(name)`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export interface FieldPresentation {
  /** The override label for a native field, or the fallback. */
  label: (name: string, fallback: string) => string;
  /** Whether the workspace has hidden this native field. */
  hidden: (name: string) => boolean;
  isLoading: boolean;
}

export function useFieldPresentation(entityKind: string): FieldPresentation {
  const { activeSlug } = useActiveOrg();
  const overrides = useQuery({
    queryKey: ["native-field-overrides", activeSlug, entityKind],
    queryFn: () => api.listNativeFieldOverrides(activeSlug, entityKind),
    enabled: !!activeSlug && !!entityKind,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const byName = new Map((overrides.data?.items ?? []).map((o) => [o.name, o]));
    return {
      label: (name, fallback) => byName.get(name)?.display_label || fallback,
      hidden: (name) => byName.get(name)?.hidden ?? false,
      isLoading: overrides.isLoading,
    };
  }, [overrides.data, overrides.isLoading]);
}
