import { PlacementCard } from "./Placement.js";
import type { BoardRevision } from "../api/board-revisions.js";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NumberField, QueryError } from "@cobblr/platform-web";
import { useBoardAction } from "./BoardRevisions.js";
import type { BuildsApi } from "./api.js";
import { randomId } from "@cobblr/platform-contract/random-id";
const input = "block w-full rounded border border-line bg-surface p-2 text-sm";
const button = "rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
export function AssemblyOrdersCard({ slug, buildId, spec, api }: { slug: string; buildId: string; spec: BoardRevision; api: BuildsApi }) {
  const call = useBoardAction(slug), qc = useQueryClient();
  const [boards, setBoards] = useState(50), [key, setKey] = useState(() => randomId());
  const [params] = useSearchParams();
  const [id, setId] = useState(params.get("order") ?? ""), [error, setError] = useState("");
  const ordersKey = ["assembly-orders", slug, buildId], orderKey = ["assembly-order", slug, id];
  const orders = useQuery({ queryKey: ordersKey, queryFn: () => api.assemblyOrders(buildId) });
  const order = useQuery({ queryKey: orderKey, queryFn: () => api.assemblyOrder(id), enabled: !!id, refetchInterval: 60_000 });
  const operation = useMutation({ mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); await qc.invalidateQueries({ queryKey: ordersKey }); await qc.invalidateQueries({ queryKey: orderKey }); }, onError: e => setError(e instanceof Error ? e.message : "The order did not change.") });
  const change = (operationName: string) => operation.mutate(async () => { await call("builds:change-assembly-order", { order_id: id, operation: operationName }); });
  const state = order.data?.assembly.state;
  return <section className="rounded border border-line p-3 space-y-3" data-testid="assembly-work-orders">
    <h3 className="font-semibold">Assembly work orders</h3>
    <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); operation.mutate(async () => { const out = await call<{ order_id: string }>("builds:create-assembly-order", { build_id: buildId, boards, request_key: key }); setId(out.order_id); setKey(randomId()); }); }}>
      <label className="text-sm">Boards in this order<NumberField label="Boards in this order" required integer min={1} max={1_000_000} value={boards} onChange={setBoards} className={input} /></label>
      <button disabled={operation.isPending} type="submit" className={button}>Create work order</button>
    </form>
    {orders.isError ? <QueryError what="work orders" onRetry={() => { void orders.refetch(); }} /> : <label className="block text-sm">Work order<select aria-label="Work order" className={input} value={id} onChange={e => setId(e.target.value)}><option value="">Choose an order</option>{orders.data?.items.map(o => <option key={o.id} value={o.id}>{o.qty} boards · {o.assembly.state} · {o.id.slice(0, 8)}</option>)}</select></label>}
    {order.isError && <QueryError what="the kit" onRetry={() => { void order.refetch(); }} />}
    {order.data && <div className="space-y-3"><p role="status">{order.data.qty} boards · {state}</p>
      {["kitted", "released", "pasted", "placing"].includes(state ?? "") && order.data.kit.reason && <p role="status" className="text-ember-700 dark:text-ember-300">{order.data.kit.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {state === "draft" && <button type="button" disabled={operation.isPending} className={button} onClick={() => change("kit")}>Reserve kit</button>}
        {state === "kitted" && <button type="button" disabled={operation.isPending} className={button} onClick={() => change("release")}>Check and release kit</button>}
        {["draft", "kitted", "released"].includes(state ?? "") && <button type="button" disabled={operation.isPending} className={button} onClick={() => change("cancel")}>Cancel and release reservations</button>}
      </div>
      {["released", "pasted", "placing", "placed", "reflowed", "tested"].includes(state ?? "") && <PlacementCard key={order.data.id} slug={slug} order={order.data} spec={spec} api={api} />}
      {!!order.data.kit.lines.length && <div><h4 className="text-sm font-semibold">Kit list by location</h4><ul className="space-y-2 mt-2">{order.data.kit.lines.map((line, i) => <li key={`${line.part_id}-${i}`} className="rounded border border-line p-2 text-sm"><p>{line.location} · {line.qty} {line.role === "blank" ? "blank boards" : "components including loss"}</p><Link className="text-accent underline break-all" to={openRecordPath(line.kind, line.part_id)}>{line.name}</Link>{line.lot_code && <p className="text-muted">Lot {String(line.lot_code)}</p>}</li>)}</ul></div>}
      {state === "released" && <p className="text-sm text-muted">Kit released. Warm and check the paste before applying it.</p>}
    </div>}
    {error && <p role="alert" className="text-ember-700 dark:text-ember-300">{error}</p>}
  </section>;
}
