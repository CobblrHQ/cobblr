// /configuration/farm — manage print-farm connections (FDM Monster +).
// Add a connection, test it (capability probe), list its printers. The
// send/print-queue surface stays API-only for now — starting a real
// print is a deliberate action, not a UI button.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wifi, Printer, RefreshCw } from "lucide-react";
import { ApiError, api, type FarmConnection } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

export function PrintFarmPage() {
  usePageTitle("Print farm");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [printersFor, setPrintersFor] = useState<FarmConnection | null>(null);

  const list = useQuery({
    queryKey: ["farm-connections", activeSlug],
    queryFn: () => api.listFarmConnections(activeSlug),
    enabled: !!activeSlug,
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testFarmConnection(activeSlug, id),
    onSuccess: (r) => {
      toast[r.ok ? "success" : "error"](
        r.ok ? `Connected${r.capabilities?.routing ? " · routing supported" : ""}` : `Failed: ${r.detail ?? "unknown"}`,
      );
      void qc.invalidateQueries({ queryKey: ["farm-connections", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteFarmConnection(activeSlug, id),
    onSuccess: () => {
      toast.success("Connection removed");
      void qc.invalidateQueries({ queryKey: ["farm-connections", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">Print farm</h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">{items.length} connection{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Add connection
        </button>
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Connect a print farm — FDM Monster and friends — over its REST API. Test it, map its
        printers to your machines, and (via the API) send print jobs that track to completion.
      </p>

      {list.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-slate-500 dark:text-slate-400 italic">
          No connections yet. Add one to point Cobblr at your farm.
        </div>
      )}

      <ul className="border border-slate-200 dark:border-slate-700 rounded divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((c) => (
          <li key={c.id} className="px-3 py-2.5 flex items-center gap-3">
            <Printer size={16} className="text-slate-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-700 dark:text-mortar-100 truncate flex items-center gap-2">
                {c.label}
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{c.type}</span>
                {c.capabilities?.routing && (
                  <span className="text-[10px] font-mono text-moss-600 dark:text-moss-400">routing</span>
                )}
              </div>
              <div className="text-[11px] font-mono text-slate-400 truncate">{c.base_url}</div>
              {c.last_sync_status && (
                <div className={"text-[11px] " + (c.last_sync_status === "ok" ? "text-moss-600 dark:text-moss-400" : "text-ember-500")}>
                  {c.last_sync_status === "ok" ? "✓ reachable" : c.last_sync_status}
                </div>
              )}
            </div>
            <button
              onClick={() => test.mutate(c.id)}
              disabled={test.isPending}
              title="Test connection"
              className="text-slate-400 hover:text-cobble-600 transition p-1.5 disabled:opacity-50"
            >
              {test.isPending && test.variables === c.id ? <RefreshCw size={15} className="animate-spin" /> : <Wifi size={15} />}
            </button>
            <button
              onClick={() => setPrintersFor(c)}
              title="List printers"
              className="text-slate-400 hover:text-cobble-600 transition p-1.5"
            >
              <Printer size={15} />
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove "${c.label}"?`,
                  message: "Deletes the connection + its stored credentials. Print history isn't sent anywhere.",
                  confirmLabel: "Remove",
                  destructive: true,
                });
                if (ok) del.mutate(c.id);
              }}
              title="Remove"
              className="text-slate-400 hover:text-ember-500 transition p-1.5"
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      {createOpen && (
        <CreateConnectionModal
          types={list.data?.types ?? ["fdm_monster", "mock"]}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["farm-connections", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
      {printersFor && <PrintersModal connection={printersFor} onClose={() => setPrintersFor(null)} />}
    </div>
  );
}

function CreateConnectionModal({
  types,
  onClose,
  onCreated,
}: {
  types: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [type, setType] = useState(types[0] ?? "fdm_monster");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authMode, setAuthMode] = useState<"api_key" | "login">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.createFarmConnection(activeSlug, {
        type,
        label: label.trim(),
        base_url: baseUrl.trim(),
        ...(type === "mock"
          ? {}
          : authMode === "api_key"
            ? { api_key: apiKey.trim() || undefined }
            : { username: username.trim() || undefined, password: password || undefined }),
      }),
    onSuccess: () => {
      toast.success("Connection added");
      onCreated();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1";

  return (
    <Modal open onClose={onClose} title="Add print-farm connection" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className={lbl}>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {types.map((t) => (
              <option key={t} value={t}>{t === "fdm_monster" ? "FDM Monster" : t === "mock" ? "Mock (test)" : t}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={lbl}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main FDM farm" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://farm.local:4000" className={field} />
        </label>
        {type !== "mock" && (
          <>
            <div className="flex gap-2 text-xs">
              {(["api_key", "login"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthMode(m)}
                  className={"px-2 py-1 rounded border transition " + (authMode === m ? "border-cobble-500 text-cobble-600" : "border-slate-300 dark:border-slate-600 text-slate-500")}
                >
                  {m === "api_key" ? "API key" : "Username + password"}
                </button>
              ))}
            </div>
            {authMode === "api_key" ? (
              <label className="block">
                <span className={lbl}>API key</span>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="fdmm_api_…" className={field} />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={lbl}>Username</span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
                </label>
                <label className="block">
                  <span className={lbl}>Password</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
                </label>
              </div>
            )}
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={save.isPending || !label.trim() || !baseUrl.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {save.isPending ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PrintersModal({ connection, onClose }: { connection: FarmConnection; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const printers = useQuery({
    queryKey: ["farm-printers", activeSlug, connection.id],
    queryFn: () => api.listFarmPrinters(activeSlug, connection.id),
  });
  const items = printers.data?.items ?? [];
  return (
    <Modal open onClose={onClose} title={`${connection.label} — printers`} size="md">
      {printers.isLoading && <div className="text-sm text-slate-500">Loading printers…</div>}
      {printers.isError && <div className="text-sm text-ember-500">Couldn't reach the farm — test the connection.</div>}
      {!printers.isLoading && !printers.isError && items.length === 0 && (
        <div className="text-sm text-slate-500 italic">No printers reported.</div>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((p) => (
          <li key={p.id} className="py-2 flex items-center gap-2 text-sm">
            <Printer size={14} className="text-slate-400" />
            <span className="flex-1 text-slate-700 dark:text-mortar-100">{p.name}</span>
            {p.state && <span className="text-[11px] text-slate-400">{p.state}</span>}
            <span className={"text-[11px] " + (p.enabled ? "text-moss-600 dark:text-moss-400" : "text-slate-400")}>{p.enabled ? "enabled" : "disabled"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-slate-400">Map these to your machines + send jobs via the API (the print-queue UI is next).</p>
    </Modal>
  );
}
