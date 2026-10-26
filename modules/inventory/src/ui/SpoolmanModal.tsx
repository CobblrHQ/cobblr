import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, useCan, useRoleAtLeast, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";

export function SpoolmanModal({
  instance,
  onClose,
  onSynced,
}: {
  instance?: string;
  onClose: () => void;
  onSynced: () => void;
}) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const mayConnect = useRoleAtLeast(ADMIN_TIER), maySync = useCan("inventory:pull-connected-stock");
  const [label, setLabel] = useState("Spoolman");
  const [authority, setAuthority] = useState<"" | "spoolman" | "cobblr">("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const conns = useQuery({ queryKey: ["spoolman-connections"], queryFn: () => api.listSpoolman() });
  const items = conns.data?.items ?? [];
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["spoolman-connections"] });

  const create = useMutation({
    mutationFn: () => api.createSpoolman({ label: label.trim(), base_url: baseUrl.trim(), api_key: apiKey.trim() || undefined }),
    onSuccess: () => {
      setBaseUrl("");
      setApiKey("");
      toast.success("Spoolman connected");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sync = useMutation({
    mutationFn: (id: string) => api.syncSpoolman(id, instance, authority || undefined),
    onSuccess: (r) => {
      toast.success(`Synced ${r.synced} spool${r.synced === 1 ? "" : "s"}: ${r.created} new, ${r.updated} updated`);
      onSynced();
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteSpoolman(id),
    onSuccess: () => {
      toast.success("Removed");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  return (
    <Modal open onClose={onClose} title="Spoolman" size="sm">
      <div className="space-y-3">
        <p className="text-[13px] text-muted dark:text-slate-400">
          Spoolman is optional. Choose which app records use. Spoolman tracking pulls its remaining weight. Cobblr tracking records prints here and sends remaining weight and location back to Spoolman.
        </p>
        <label className="block text-sm">Who records use after sync?
          <select aria-label="Who records use after sync?" value={authority} onChange={(e) => setAuthority(e.target.value as typeof authority)} className={field}>
            <option value="">Keep the saved choice</option>
            <option value="spoolman">Spoolman</option>
            <option value="cobblr">Cobblr</option>
          </select>
        </label>
        {items.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded border border-line dark:border-slate-700 p-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">{c.label}</div>
              <div className="text-[11px] font-mono text-faint truncate">{c.base_url}</div>
            </div>
            {maySync && <button
              onClick={() => sync.mutate(c.id)}
              disabled={sync.isPending}
              className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-2.5 py-1 disabled:opacity-50"
            >
              {sync.isPending ? "syncing…" : "Sync now"}
            </button>}
            {mayConnect && <button onClick={() => del.mutate(c.id)} className="text-[11px] text-faint hover:text-ember-500 px-1">
              Remove
            </button>}
          </div>
        ))}
        {items.length === 0 && !conns.isLoading && !mayConnect && <p className="text-sm text-muted">An owner or admin connects Spoolman.</p>}
        {items.length === 0 && !conns.isLoading && mayConnect && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (baseUrl.trim()) create.mutate();
            }}
            className="space-y-2"
          >
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className={field} />
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://spoolman.local:7912" className={field} />
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key (optional)" className={field} />
            <button
              type="submit"
              disabled={!baseUrl.trim() || create.isPending}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              {create.isPending ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

