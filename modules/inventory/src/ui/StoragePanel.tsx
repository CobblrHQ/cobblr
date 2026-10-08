import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRunAction } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { randomId } from "@cobblr/platform-contract";

export function StoragePanel({ id }: { id: string }) {
  const { api, entityKind } = useInventory();
  // PRESS-ARGS: storage changes carry the current revision; the count and placement forms supply their required values.
  const run = useRunAction();
  const [clock, setClock] = useState(Date.now);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bake, setBake] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [temperature, setTemperature] = useState("");
  const [instruction, setInstruction] = useState("");
  const [count, setCount] = useState("");
  const [placements, setPlacements] = useState("");
  const [runId, setRunId] = useState<string>(() => randomId());
  const query = useQuery({ queryKey: ["inventory-storage", id], queryFn: () => api.storage(id), refetchInterval: 60_000, meta: { kinds: [entityKind] } });
  const view = query.data;
  const bakeEnd = view?.state.bake ? Date.parse(view.state.bake.started_at) + view.state.bake.minutes * 60_000 : null;
  useEffect(() => {
    if (bakeEnd == null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const now = Date.now();
      setClock(now);
      if (now < bakeEnd) timer = setTimeout(tick, Math.min(bakeEnd - now + 1, 2_147_483_647));
    };
    tick();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [bakeEnd]);
  async function act(actionId: string, args: Record<string, unknown>) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const out = await run({ actionId, ...(actionId === "inventory:consume-with-loss" ? {} : { entityKind: "inventory:part", entityId: id }), args: { partId: id, ...args } });
      const result = out.result as { data?: { already_consumed?: boolean } };
      setNotice(actionId === "inventory:consume-with-loss" ? result.data?.already_consumed ? "Already recorded. Count unchanged." : "Placements recorded." : actionId === "inventory:set-stock" ? "Count recorded." : "Storage recorded.");
      return true;
    }
    catch (e) { setError(e instanceof Error ? e.message : "The stock did not change."); return false; }
    finally { setBusy(false); }
  }
  if (query.isError) return <p role="alert" className="text-sm">Could not read the storage history.</p>;
  if (!view) return null;
  const change = (operation: string, extra: Record<string, unknown> = {}) => act("inventory:change-storage", { revision: view!.revision, operation, ...extra });
  const input = "input block w-full";
  return <section className="rounded-xl border border-line p-4 space-y-3" data-testid="stock-storage">
    <h3 className="text-sm font-semibold">Moisture and count</h3>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <p role="alert" className="text-sm text-ember-700 dark:text-ember-300">{error}</p>}
    <p className="text-sm">MSL {view.msl ?? "not known"} · {view.state.mode} · {(view.exposed_ms / 3_600_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} hours exposed</p>
    <p className={`text-sm ${view.usable ? "text-muted" : "text-ember-700 dark:text-ember-300"}`} role="status">{view.reason ?? (view.remaining_hours == null ? "No floor-life limit." : `${Math.max(0, view.remaining_hours).toFixed(1)} hours of floor life left.`)}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy || view.state.mode === "baking"} onClick={() => void change("open")} className="rounded border border-line px-3 py-2 text-sm">Opened</button>
      <button type="button" disabled={busy || view.state.mode === "baking"} onClick={() => void change("dry")} className="rounded border border-line px-3 py-2 text-sm">Back in the dry cabinet</button>
      {view.state.mode === "baking" ? <button type="button" disabled={busy || clock < bakeEnd!} onClick={() => void change("complete-bake")} className="rounded border border-line px-3 py-2 text-sm">Complete bake</button>
        : <button type="button" onClick={() => setBake(!bake)} className="rounded border border-line px-3 py-2 text-sm">Bake</button>}
    </div>
    {view.state.bake && <p className="text-xs text-muted">Bake: {view.state.bake.minutes} minutes at {view.state.bake.temperature_c} °C. Ready after {new Date(Date.parse(view.state.bake.started_at) + view.state.bake.minutes * 60_000).toLocaleString()}. {view.state.bake.instruction}</p>}
    {bake && view.state.mode !== "baking" && <form className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm" onSubmit={e => { e.preventDefault(); void change("start-bake", { minutes: Number(minutes), temperature_c: Number(temperature), instruction }).then(changed => { if (changed) setBake(false); }); }}>
      <p className="sm:col-span-2 text-muted">Use the component manufacturer’s bake instruction. Check that the reel or tray tolerates its temperature.</p>
      <label>Duration (minutes)<input required type="number" min="1" className={input} value={minutes} onChange={e => setMinutes(e.target.value)} /></label>
      <label>Temperature (°C)<input required type="number" min="1" max="500" className={input} value={temperature} onChange={e => setTemperature(e.target.value)} /></label>
      <label className="sm:col-span-2">Manufacturer instruction<input required className={input} value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
      <button disabled={busy} type="submit" className="rounded bg-cobble-600 text-white px-3 py-2">Start bake timer</button>
    </form>}
    <details className="space-y-3"><summary className="cursor-pointer text-sm">Count and placements</summary>
    <form className="flex flex-wrap gap-2 items-end text-sm" onSubmit={e => { e.preventDefault(); void act("inventory:set-stock", { qty: Number(count), reason: "Counted package" }); }}>
      <label>I counted it<input type="number" required min="0" step="1" className={input} value={count} onChange={e => setCount(e.target.value)} /></label>
      <button disabled={busy} type="submit" className="rounded border border-line px-3 py-2">Record count</button>
    </form>
    <form className="space-y-2 text-sm" onSubmit={e => { e.preventDefault(); void act("inventory:consume-with-loss", { sourceId: runId, lines: [{ partId: id, placements: Number(placements) }] }); }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><label>Placements<input required type="number" min="1" step="1" className={input} value={placements} onChange={e => setPlacements(e.target.value)} /></label><label>Run identifier<input required className={input} value={runId} onChange={e => setRunId(e.target.value)} /></label></div>
      <p className="text-xs text-muted">The package’s attrition percentage is added to placements. Keep the same run identifier when retrying a completion.</p>
      <button disabled={busy || !view.usable} type="submit" className="rounded border border-line px-3 py-2">Record placements</button>
    </form>
    </details>
  </section>;
}
