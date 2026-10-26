import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MutationError, QueryError, useCan } from "@cobblr/platform-web";
import { useInventory } from "./context";

import { countOf } from "@cobblr/platform-contract/plural";
export function FilamentCatalog() {
  const { api } = useInventory();
  const mayImport = useCan("inventory:create-item");
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [imported, setImported] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["filament-catalog", search], queryFn: () => api.searchFilamentCatalog(search), enabled: search.length >= 2 });
  const add = useMutation({ mutationFn: (id: string) => api.importFilamentType(id), onSuccess: () => { setImported("Filament type added. Add a physical spool from its type when you have one."); void qc.invalidateQueries({ queryKey: ["inventory-parts"] }); void qc.invalidateQueries({ queryKey: ["inventory-family"] }); } });
  // Importing adds a type: a person who may not add one is not offered the search for it.
  if (!mayImport) return null;
  return <section className="rounded-xl border border-line p-3 space-y-2" data-testid="filament-catalog">
    <h3 className="text-sm font-semibold">Import a filament type</h3>
    <p className="text-xs text-muted">Search the public SpoolmanDB catalog by maker, material or product name. This adds a type and vendor, with no spool or stock count.</p>
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(input.trim()); setImported(null); }}>
      <input aria-label="Filament catalog search" value={input} onChange={(e) => setInput(e.target.value)} minLength={2} required className="rounded border border-line bg-surface p-2 text-sm min-w-0 flex-1" />
      <button className="rounded bg-cobble-600 text-white px-3 py-2 text-sm" disabled={q.isFetching}>Search catalog</button>
    </form>
    {q.isError && <QueryError what="filament catalog" onRetry={() => { void q.refetch(); }} />}
    {q.data && <p className="text-xs text-muted">{q.data.total ? `${countOf(q.data.total, "match")}. Showing ${q.data.items.length}.` : "No matching filaments."}</p>}
    <ul className="space-y-2">{q.data?.items.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="flex-1 min-w-0">{r.manufacturer} {r.name} · {r.material}</span>
      <button type="button" disabled={add.isPending} onClick={() => add.mutate(r.id)} className="rounded border border-line px-2 py-1 text-sm">Import type</button>
    </li>)}</ul>
    <MutationError mutation={add} />
    {imported && <p role="status" className="text-sm">{imported}</p>}
  </section>;
}
