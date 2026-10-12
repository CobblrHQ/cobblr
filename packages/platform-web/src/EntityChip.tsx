// EntityChip: a record a page holds only by (kind, id), named the way a person
// knows it and linked to where it opens. The page-side twin of the platform
// record namer (@cobblr/platform-contract/record-subjects): never the stored
// kind, never an id (#5977). A record it cannot find, gone or hidden from the
// reader, reads as words.

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
    "inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-0.5 text-[11px]";

  if (isLoading) return <span className={base}>…</span>;
  if (error || !data) {
    return <span className={`${base} text-faint dark:text-slate-500 italic`}>a record you cannot open</span>;
  }

  const inner = <span className="text-content dark:text-mortar-100 truncate max-w-[200px]">{data.title}</span>;
  if (data.detailUrl) {
    return (
      <Link to={data.detailUrl} className={`${base} hover:border-cobble-300 dark:hover:border-cobble-500 transition`}>
        {inner}
      </Link>
    );
  }
  return <span className={base}>{inner}</span>;
}
