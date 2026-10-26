import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FieldPack, fieldNeed, fieldPackControlClass, useToast, SearchInput, downloadBlob, useRoleAtLeast } from "@cobblr/platform-web";
import { ownAddressName, ownAddressSentWords, ownAddressVCard } from "@cobblr/platform-contract/address-name";
import type { SalesApi, IntakeView } from "./api.js";

export function IntakeSettings({ api }: { api: SalesApi }) {
  const setsUp = useRoleAtLeast(ADMIN_TIER);
  const address = useQuery({ queryKey: ["sales-order-email-address", api.workspace], queryFn: () => api.orderEmailAddress() });
  const q = useQuery({ queryKey: ["sales-intake", api.workspace], queryFn: () => api.intake(), refetchInterval: 15_000 });
  if (q.isError) return <p role="alert">Order intake settings could not be read. Reopen Sales settings to try again.</p>;
  if (!q.data) return <p>Loading order intake…</p>;
  return <><section className="space-y-2 border-t border-line pt-3" aria-label="Order emails">
    <h3 className="font-medium">Order emails</h3>
    {address.data?.order_address ? <><p className="text-xs text-muted">Forward sales emails here. Each order becomes a draft with the email for you to review and confirm.</p><p className="text-sm break-all select-all">{address.data.order_address}</p><OrderAddressActions api={api} address={address.data.order_address} name={address.data.order_name ?? ownAddressName("orders", null)} /></> : <p className="text-xs text-muted">Order email forwarding needs the operator's inbound email setup.</p>}
    {address.isError && <p role="alert">The order email address could not be read.</p>}
  </section>{setsUp ? <IntakeForm key={`${q.data.setting?.connection ?? "new"}:${q.data.setting?.on}`} api={api} view={q.data} /> : <p className="text-xs text-muted border-t border-line pt-3">An owner or administrator sets up automatic order intake.</p>}</>;
}
/** "Email it to me" and "Add to contacts" for the orders address, so typing
 *  "Cobblr" in a To field finds "Cobblr Orders" (#5462). */
function OrderAddressActions({ api, address, name }: { api: SalesApi; address: string; name: string }) {
  const toast = useToast();
  const send = useMutation({ mutationFn: () => api.emailMyOrderAddress(), onError: (e) => toast.error(e.message) });
  return <div className="space-y-1 text-xs">
    {send.data && <p role="status" className="text-muted">{ownAddressSentWords(send.data.to, "orders")}</p>}
    <p className="flex gap-3">
      <button type="button" className="underline" disabled={send.isPending} onClick={() => send.mutate()}>{send.isPending ? "Sending…" : send.data ? "Resend" : "Email it to me"}</button>
      <button type="button" className="underline" onClick={() => downloadBlob(new Blob([ownAddressVCard({ name, address })], { type: "text/vcard" }), `${name.replace(/[^\w ()'-]+/g, "").trim() || "Cobblr"}.vcf`)}>Add to contacts</button>
    </p>
  </div>;
}
function IntakeForm({ api, view }: { api: SalesApi; view: IntakeView }) {
  const qc = useQueryClient();
  const toast = useToast();
  // DRAFT-OK: setup fields are saved together, apart from the polling status below.
  const [connection, setConnection] = useState(view.setting?.connection ?? view.connections[0]?.id ?? "");
  const [on, setOn] = useState(view.setting?.on ?? false);
  const [mapping, setMapping] = useState<Record<string, string>>(view.setting?.mapping ?? {});
  const [sku, setSku] = useState("");
  const [partSearch, setPartSearch] = useState("");
  const [part, setPart] = useState("");
  const parts = useQuery({ queryKey: ["sales-intake-parts", api.workspace, partSearch], queryFn: () => api.searchParts(partSearch) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["sales-intake", api.workspace] }); void qc.invalidateQueries({ queryKey: ["sales-orders"] }); };
  const save = useMutation({ mutationFn: () => api.setIntake({ on, connection, mapping }), onSuccess: () => { toast.success("Order intake saved"); refresh(); }, onError: (e) => toast.error(e.message) });
  const check = useMutation({ mutationFn: () => api.checkIntake(), onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const style = "rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm " + fieldPackControlClass;
  return <section className="space-y-3 border-t border-line pt-3" aria-label="Automatic order intake">
    <h3 className="font-medium">Automatic order intake</h3>
    <p className="text-xs text-muted">Bring orders in from your email or store every minute. Orders are confirmed, unpaid, and ready to review. Intake never ships them.</p>
    <Link to="/me/connections?add=service&capability=orders.list" className="text-sm underline">Connect an order source</Link>
    <p className="text-xs text-muted">Choose WooCommerce orders or Order feed, then share the connection with this workspace. An owner or administrator saves these settings.</p>
    <FieldPack items={[{ need: fieldNeed("source", { control: "picker", label: "Order source" }), node: <label className="block text-xs">Order source<select aria-label="Order source" value={connection} onChange={(e) => setConnection(e.target.value)} className={style} disabled={!!view.setting?.on}>
      <option value="">Choose a connection</option>{view.connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select></label> }]} />
    <label className="flex gap-2 items-center"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />Bring orders in automatically</label>
    <p className="text-xs text-muted">Map each source SKU to a part. A missing mapping stops intake and tells you which SKU needs a part. Lines without a SKU stay untracked.</p>
    <label className="block text-xs">Search inventory<SearchInput aria-label="Search inventory" value={partSearch} onChange={setPartSearch} placeholder="Search inventory" /></label>
    <FieldPack items={[
      { need: fieldNeed("sku", { control: "text", label: "Source SKU" }), node: <label className="block text-xs">Source SKU<input aria-label="Source SKU" value={sku} onChange={(e) => setSku(e.target.value)} className={style} /></label> },
      { need: fieldNeed("part", { control: "picker", label: "Inventory part" }), node: <label className="block text-xs">Inventory part<select aria-label="Inventory part" value={part} onChange={(e) => setPart(e.target.value)} className={style}><option value="">Choose a part</option>{(parts.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label> },
    ]} />
    <button type="button" disabled={!sku.trim() || !part} onClick={() => { setMapping({ ...mapping, [sku.trim()]: part }); setSku(""); }} className="rounded border border-line px-3 py-1.5 disabled:opacity-50">Add SKU mapping</button>
    <ul className="space-y-1">{Object.entries(mapping).map(([code, id]) => <li key={code} className="flex items-center justify-between gap-2 text-xs"><span className="min-w-0 break-words">{code}: {parts.data?.find((p) => p.id === id)?.title ?? "Saved inventory mapping"}</span><button type="button" aria-label={`Remove mapping ${code}`} onClick={() => setMapping(Object.fromEntries(Object.entries(mapping).filter(([k]) => k !== code)))} className="underline shrink-0">Remove</button></li>)}</ul>
    <div className="flex gap-2 flex-wrap"><button type="button" onClick={() => save.mutate()} disabled={!connection || save.isPending} className="rounded border border-line px-3 py-1.5 disabled:opacity-50">Save intake settings</button>
      <button type="button" onClick={() => check.mutate()} disabled={!view.setting?.on || check.isPending || save.isPending} className="rounded border border-line px-3 py-1.5 disabled:opacity-50">Check order source now</button></div>
    {view.setting?.error && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300 break-words">{view.setting.error}</p>}
    {view.setting && <p className="text-xs text-muted">{view.setting.imported} order{view.setting.imported === 1 ? "" : "s"} imported. {view.setting.duplicates} duplicate{view.setting.duplicates === 1 ? "" : "s"} skipped.{view.setting.job ? " Waiting for the source to answer." : ""}{view.setting.checked_at ? ` Last checked ${new Date(view.setting.checked_at).toLocaleString()}.` : ""}</p>}
  </section>;
}
