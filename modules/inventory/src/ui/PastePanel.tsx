import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FieldPack, fieldNeed, QueryError, useRunAction } from "@cobblr/platform-web";
import { useInventory } from "./context";
const button = "rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
export function PastePanel({ id }: { id: string }) {
  const { api, entityKind } = useInventory();
  // PRESS-ARGS: handling forms carry this jar, its current revision and the selected operation.
  const run = useRunAction();
  const [lot, setLot] = useState(""), [expires, setExpires] = useState("");
  const [warmup, setWarmup] = useState(4), [workLife, setWorkLife] = useState("");
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["paste-storage", id], queryFn: () => api.paste(id), refetchInterval: 60_000, meta: { kinds: [entityKind] } });
  const readyAt = query.data?.ready_at;
  useEffect(() => {
    if (!readyAt || Date.parse(readyAt) <= Date.now()) return;
    const timer = setTimeout(() => { void query.refetch(); }, Math.min(Date.parse(readyAt) - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [readyAt, query.refetch]);
  const operation = useMutation({ mutationFn: async (args: Record<string, unknown>) => {
    setError("");
    await run({ actionId: "inventory:change-paste", args: { partId: id, revision: query.data!.revision, ...args } });
    await query.refetch();
  }, onError: e => setError(e instanceof Error ? e.message : "The paste history did not change.") });
  if (query.isError) return <QueryError what="paste handling" onRetry={() => { void query.refetch(); }} />;
  if (!query.data) return <p className="text-sm" aria-busy="true">Reading paste handling…</p>;
  const view = query.data;
  const change = (name: string) => operation.mutate({ operation: name });
  return <section className="rounded border border-line p-4 space-y-3" data-testid="paste-lifecycle">
    <h3 className="font-semibold">Paste handling</h3>
    <p role="status" className={view.usable ? "text-sm" : "text-sm text-ember-700 dark:text-ember-300"}>{view.reason ?? "Paste is warm and within its label limits."}</p>
    {!view.state ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); operation.mutate({ operation: "configure", limits: { lot, expires_on: expires, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, warmup_hours: warmup, work_life_hours: Number(workLife) } }); }}>
      <p className="text-sm text-muted">Configure this jar as liquid stock in ml first. Record a newly received, refrigerated jar. Use its manufacturer's handling limits and the shelf expiry on its label.</p>
      <FieldPack maxCols={2} items={[
        { need: fieldNeed("lot", { control: "text", label: "Paste lot" }), node: <label className="block text-sm">Paste lot<input className="input block w-full" aria-label="Paste lot" required value={lot} onChange={e => setLot(e.target.value)} /></label> },
        { need: fieldNeed("expiry", { control: "date", label: "Shelf expiry" }), node: <label className="block text-sm">Shelf expiry<input className="input block w-full" aria-label="Shelf expiry" type="date" required value={expires} onChange={e => setExpires(e.target.value)} /></label> },
        { need: fieldNeed("warmup", { control: "number", label: "Warm-up hours" }), node: <label className="block text-sm">Warm-up hours<input className="input block w-full" aria-label="Warm-up hours" type="number" required min={0.01} max={72} step="any" value={warmup} onChange={e => setWarmup(Number(e.target.value))} /></label> },
        { need: fieldNeed("work-life", { control: "number", label: "Work life out of cold storage (hours)" }), node: <label className="block text-sm">Work life out of cold storage (hours)<input className="input block w-full" aria-label="Work life out of cold storage (hours)" type="number" required min={0.01} max={8760} step="any" value={workLife} onChange={e => setWorkLife(e.target.value)} /></label> },
      ]} />
      <button type="submit" disabled={operation.isPending} className={button}>Record refrigerated jar</button>
    </form> : <>
      <p className="text-sm">Lot {view.state.lot} · shelf expiry {view.state.expires_on} · {view.state.mode === "cold" ? "Refrigerated" : view.state.opened_at ? "Opened" : "Out of the refrigerator"}</p>
      <p className="text-sm">{view.remaining_hours?.toFixed(1)} hours of work life left.{readyAt && ` Warm after ${new Date(readyAt).toLocaleString()}.`}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={operation.isPending || view.state.mode !== "cold"} className={button} onClick={() => change("out")}>Out of the fridge</button>
        <button type="button" disabled={operation.isPending || !view.usable || !!view.state.opened_at} className={button} onClick={() => change("open")}>Opened after warming</button>
        <button type="button" disabled={operation.isPending || !!view.state.opened_at || view.state.mode === "cold"} className={button} onClick={() => change("cold")}>Unopened jar back in fridge</button>
      </div>
      <p className="text-xs text-muted">Returning an unopened jar to cold storage pauses work life. It must warm again before use. An opened jar keeps its clock.</p>
    </>}
    {error && <p role="alert" className="text-sm text-ember-700 dark:text-ember-300">{error}</p>}
  </section>;
}
