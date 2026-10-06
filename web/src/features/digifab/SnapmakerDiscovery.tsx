import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";

export function SnapmakerDiscovery({ slug, bridge, onFound }: { slug: string; bridge: string | null; onFound: (machine: { name: string; host: string; transport: "http" | "sacp" }) => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.discoverSnapmakers>>["items"]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const discovery = useMutation({ mutationFn: async () => { setBusy(true); setError(""); try { const found = await api.discoverSnapmakers(slug, bridge); setItems(found.items); setSearched(true); } catch (e) { setError(e instanceof Error ? e.message : "Discovery could not finish."); } finally { setBusy(false); } } });
  return <div className="space-y-2 text-sm col-span-2">
    <button type="button" className="min-h-11 rounded border border-line px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void discovery.mutateAsync()}>{busy ? "Looking on your network…" : "Find Snapmakers"}</button>
    {error && <p role="alert">{error}</p>}
    {searched && items.length === 0 && <p>No Snapmakers replied. Enter the machine's IP address, or check that it and the bridge use the same network.</p>}
    {items.map(machine => <div key={machine.host} className="rounded border border-line p-2 space-y-1">
      <p>Found: {machine.model} at {machine.host}</p>
      {<button type="button" className="min-h-11 underline" onClick={() => onFound(machine)}>Use {machine.name}</button>}
    </div>)}
  </div>;
}
