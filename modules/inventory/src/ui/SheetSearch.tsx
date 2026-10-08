import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Modal, QueryError, SearchInput, NumberField } from "@cobblr/platform-web";
import { useInventory } from "./context";

export function SheetSearch() {
  const { api, orgSlug } = useInventory();
  const [open, setOpen] = useState(false);
  const [material, setMaterial] = useState("");
  const [thickness, setThickness] = useState<number | "">(3);
  const [width, setWidth] = useState<number | "">(120);
  const [height, setHeight] = useState<number | "">(80);
  const [rotate, setRotate] = useState(true);
  const [search, setSearch] = useState<{ material: string; thickness_mm: number; width_mm: number; height_mm: number; rotate: boolean } | null>(null);
  const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ["inventory-sheet-search", orgSlug, search, offset], queryFn: () => api.findSheets({ ...search!, offset }), enabled: open && search != null });
  return <>
    <button type="button" className="min-h-11 text-sm px-2 text-accent" onClick={() => setOpen(true)}>Find a sheet</button>
    <Modal open={open} title="Find a sheet with room" onClose={() => setOpen(false)} size="lg">
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (!material.trim()) return; setOffset(0); setSearch({ material: material.trim(), thickness_mm: Number(thickness), width_mm: Number(width), height_mm: Number(height), rotate }); }}>
        <label className="block text-sm">Material<SearchInput wrapperClassName="w-full" aria-label="Find material" placeholder="Material" value={material} onChange={setMaterial} /></label>
        <div className="grid grid-cols-3 gap-2">{([["Thickness (mm)", thickness, setThickness], ["Width (mm)", width, setWidth], ["Height (mm)", height, setHeight]] as const).map(([label, value, set]) => <label key={label} className="text-sm">{label}<NumberField className="input w-full min-h-11" label={`Needed ${label.toLowerCase()}`} min={0.001} required value={value === "" ? null : value} onChange={n => set(n)} onClear={() => set("")} /></label>)}</div>
        <label className="flex gap-2 items-center min-h-11 text-sm"><input type="checkbox" checked={rotate} onChange={e => setRotate(e.target.checked)} />A quarter turn is OK</label>
        <button className="min-h-11 rounded bg-cobble-600 text-white px-4">Find room</button>
      </form>
      <p className="text-sm text-muted mt-3">Searches all your sheet stock. Offcuts come first.</p>
      {query.isError && <QueryError what="The record could not be loaded." onRetry={() => void query.refetch()} />}
      {query.isFetching && <p className="text-sm mt-3">Looking for room…</p>}
      {query.data && <><ul className="mt-3 divide-y divide-line">{query.data.items.map(sheet => <li key={sheet.id} className="py-3"><Link className="text-accent" onClick={() => setOpen(false)} to={`/w/${orgSlug}${sheet.instance === "inventory" ? "/inventory" : `/instances/${sheet.instance}`}/parts/${sheet.id}`}>{sheet.name}</Link><p className="text-sm">{sheet.offcut ? "Offcut · " : ""}About {Math.round(sheet.percent_left)}% left</p></li>)}</ul>{query.data.total === 0 && <p className="mt-3 text-sm">No sheet has enough usable room.</p>}<div className="flex gap-2 mt-3"><button className="min-h-11 px-3 border rounded" disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 50))}>Previous</button><button className="min-h-11 px-3 border rounded" disabled={offset + 50 >= query.data.total} onClick={() => setOffset(v => v + 50)}>Next</button></div></>}
    </Modal>
  </>;
}
