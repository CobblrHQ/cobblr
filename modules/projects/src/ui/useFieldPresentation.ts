// Native-field presentation overrides, module-side. Same as inventory's hook:
// a module UI can't reach the web app's context/api, so it fetches the platform
// endpoint directly using orgSlug + getToken from useProjects(). Lets a
// bundle/config relabel + hide a project's native fields.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProjects } from "./context";

interface OverrideRow {
  name: string;
  display_label: string | null;
  hidden: boolean;
}

export function useFieldPresentation(entityKind: string): {
  label: (name: string, fallback: string) => string;
  hidden: (name: string) => boolean;
} {
  const { orgSlug, getToken } = useProjects();
  const q = useQuery({
    queryKey: ["native-field-overrides", orgSlug, entityKind],
    queryFn: async () => {
      const t = getToken();
      const res = await fetch(
        `/api/v1/orgs/${orgSlug}/native-field-overrides?kind=${encodeURIComponent(entityKind)}`,
        { headers: t ? { authorization: `Bearer ${t}` } : {} },
      );
      if (!res.ok) return { items: [] as OverrideRow[] };
      return (await res.json()) as { items: OverrideRow[] };
    },
    enabled: !!orgSlug,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const byName = new Map((q.data?.items ?? []).map((o) => [o.name, o]));
    return {
      label: (name, fallback) => byName.get(name)?.display_label || fallback,
      hidden: (name) => byName.get(name)?.hidden ?? false,
    };
  }, [q.data]);
}
