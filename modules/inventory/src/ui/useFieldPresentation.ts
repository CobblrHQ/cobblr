// Native-field presentation overrides, module-side. Same idea as the web
// app's useFieldPresentation, but a module UI can't reach the web context/api —
// it has orgSlug + getToken from useInventory(), so it fetches the platform
// endpoint directly. Lets a bundle/config relabel + hide the part modal's
// native fields (the "too many fields, too congested" fix).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useInventory } from "./context";

interface OverrideRow {
  name: string;
  display_label: string | null;
  hidden: boolean;
}

export function useFieldPresentation(entityKind: string): {
  label: (name: string, fallback: string) => string;
  hidden: (name: string) => boolean;
  /** Whether the bundle/workspace has an EXPLICIT override row for this native
   *  field on this instance. Used as a per-instance "feature flag" for the
   *  optional detail sections (maintenance / consumable): a bundle opts an
   *  instance INTO a section by listing it in `field_overrides` (hidden:false),
   *  so the generic part render code can default it on without hardcoding the
   *  instance. Absent row = the platform default. */
  configured: (name: string) => boolean;
} {
  const { orgSlug, getToken } = useInventory();
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
      configured: (name) => byName.has(name),
    };
  }, [q.data]);
}
