// EntityChip — render an entity reference by (kind, id) without
// knowing what kind it is. Hits the platform's entity lookup.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { usePlatformWeb } from "./context";

interface Props {
  kind: string;
  id: string;
  compact?: boolean;
}

export function EntityChip({ kind, id }: Props) {
  const { api, orgSlug } = usePlatformWeb();
  const { data, isLoading, error } = useQuery({
    queryKey: ["entity-chip", orgSlug, kind, id],
    queryFn: () => api.lookupEntity(orgSlug, kind, id),
    staleTime: 60_000,
    retry: false,
  });

  const base =
    "inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-0.5 text-[11px] font-mono";

  if (isLoading) return <span className={base}>…</span>;
  if (error || !data) {
    return (
      <span className={`${base} text-faint dark:text-slate-500 italic`} title={`${kind}:${id}`}>
        {kind} · unknown
      </span>
    );
  }

  const inner = (
    <>
      <span className="text-faint dark:text-slate-500">{kind}</span>
      <span className="text-content dark:text-mortar-100 truncate max-w-[200px]">
        {data.title}
      </span>
    </>
  );

  if (data.detailUrl) {
    return (
      <Link
        to={data.detailUrl}
        className={`${base} hover:border-cobble-300 dark:hover:border-cobble-500 transition`}
      >
        {inner}
      </Link>
    );
  }
  return <span className={base}>{inner}</span>;
}
