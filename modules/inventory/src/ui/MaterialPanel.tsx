import { useState } from "react";
import { useStockWrites } from "./stock-writes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MutationError, useCan } from "@cobblr/platform-web";
import { useInventory } from "./context";

export function MaterialPanel({ id }: { id: string }) {
  const { api } = useInventory();
  const stock = useStockWrites();
  const mayEdit = useCan("inventory:update-part");
  const qc = useQueryClient();
  const [mode, setMode] = useState<"gross_g" | "used_mm">("gross_g");
  const [value, setValue] = useState("");
  const query = useQuery({ queryKey: ["inventory-material", id], queryFn: () => api.material(id) });
  const tracker = useMutation({
    mutationFn: (mode: string) => api.patchPartMetadata(id, { tracked_by: mode === "firmware" ? "firmware" : null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["inventory-material", id] }); void qc.invalidateQueries({ queryKey: ["inventory-part", id] }); },
  });
  const save = useMutation({
    mutationFn: () => stock.measureMaterial(id, { [mode]: Number(value) }),
    onSuccess: () => { setValue(""); void qc.invalidateQueries({ queryKey: ["inventory-material", id] }); void qc.invalidateQueries({ queryKey: ["inventory-part", id] }); void qc.invalidateQueries({ queryKey: ["inventory-parts"] }); void qc.invalidateQueries({ queryKey: ["inventory-consumption", id] }); void qc.invalidateQueries({ queryKey: ["inventory-family"] }); },
  });
  if (query.isError) return <p role="alert">Could not read the filament measurements.</p>;
  const n = query.data;
  if (!n) return null;
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <section className="rounded-xl border border-line p-4 space-y-3" data-testid="material-numbers">
      <h3 className="text-sm font-semibold">Filament use</h3>
      <p className="text-sm">{fmt(n.remaining_g)} g left · {fmt(n.used_g)} g used · {fmt(n.initial_g)} g initially</p>
      {n.remaining_m != null && <p className="text-sm">{fmt(n.remaining_m)} m left · {fmt(n.used_m ?? 0)} m used</p>}
      <p className="text-xs text-muted">{n.first_used ? `First used ${new Date(n.first_used).toLocaleDateString()} · Last used ${new Date(n.last_used!).toLocaleDateString()}` : "No use recorded yet."}</p>
      {mayEdit && (!n.tracked_by || n.tracked_by === "firmware") && <label className="block text-sm">Who records use?
        <select aria-label="Who records use?" value={n.tracked_by === "firmware" ? "firmware" : "slicer"} disabled={tracker.isPending} onChange={(e) => tracker.mutate(e.target.value)} className="block max-w-full rounded border border-line bg-surface p-2">
          <option value="slicer">Completed prints and manual use</option>
          <option value="firmware">Firmware reports</option>
        </select>
        <MutationError mutation={tracker} />
      </label>}
      {n.tracked_by === "firmware" && <p className="text-xs text-muted">Select spool {n.spool_id} in your manager through the LAN bridge. Completed prints do not deduct this spool again.</p>}
      {!n.tracked_by && (
        <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {/* A select is as wide as its longest option; at 200% text that ran 110 px past a phone (#8613). */}
          <label className="min-w-0 max-w-full text-sm">Measurement
            <select aria-label="Measurement" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="block max-w-full rounded border border-line bg-surface p-2">
              <option value="gross_g">Weigh it (g, including spool)</option>
              <option value="used_mm">Use by length (mm)</option>
            </select>
          </label>
          <label className="min-w-0 max-w-full text-sm">{mode === "gross_g" ? "Scale reading (g)" : "Used length (mm)"}
            <input aria-label={mode === "gross_g" ? "Scale reading (g)" : "Used length (mm)"} type="number" min="0" step="any" required value={value} onChange={(e) => setValue(e.target.value)} className="block w-40 max-w-full rounded border border-line bg-surface p-2" />
          </label>
          <button type="submit" disabled={!value || save.isPending} className="rounded bg-cobble-600 text-white px-3 py-2 text-sm">Record measurement</button>
          <MutationError mutation={save} />
        </form>
      )}
    </section>
  );
}
