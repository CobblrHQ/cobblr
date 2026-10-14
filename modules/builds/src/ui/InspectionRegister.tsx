import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CollectionHeader, QueryError, SearchInput, usePageTitle } from "@cobblr/platform-web";
import type { BuildsApi } from "./api.js";

export function InspectionRegister({ api, slug }: { api: BuildsApi; slug: string }) {
  usePageTitle("Board inspections");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const inspections = useQuery({
    queryKey: ["board-inspections", slug, search, offset],
    queryFn: () => api.listInspections(search, offset),
  });
  const items = inspections.data?.items ?? [];
  return <div className="max-w-4xl space-y-4">
    <CollectionHeader
      title="Board inspections"
      kind="builds:inspection"
      exportQuery={search}
      nav={<Link to="/builds">Builds</Link>}
      search={<SearchInput aria-label="Search board inspections" value={search} onChange={value => { setSearch(value); setOffset(0); }} />}
    />
    {inspections.isPending && <p className="text-sm text-muted">Loading inspections…</p>}
    {inspections.isError && <QueryError what="board inspections" onRetry={() => void inspections.refetch()} />}
    {inspections.data && <>
      {items.length === 0 && <p className="text-sm text-muted">{search ? "No inspections match your search." : "No board inspections yet."}</p>}
      <ul aria-label="Board inspections" className="divide-y divide-line rounded border border-line">
        {items.map(board => <li key={board.id}>
          <Link to={`/builds/inspections/${board.id}`} className="flex min-h-12 items-center justify-between gap-3 p-3">
            <span className="min-w-0 break-words">{board.title}</span>
            <span className="shrink-0 text-sm">{String(board.fields.status ?? "")}</span>
          </Link>
        </li>)}
      </ul>
      <nav aria-label="Inspection pages" className="flex items-center gap-3">
        <button type="button" className="min-h-11 rounded border border-line px-4 disabled:opacity-50" disabled={offset === 0 || inspections.isFetching} onClick={() => setOffset(offset - 50)}>Previous</button>
        <span className="text-sm text-muted">Page {offset / 50 + 1}</span>
        <button type="button" className="min-h-11 rounded border border-line px-4 disabled:opacity-50" disabled={items.length < 50 || inspections.isFetching} onClick={() => setOffset(offset + 50)}>Next</button>
      </nav>
    </>}
  </div>;
}
