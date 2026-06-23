// Sync connections — mirror an external system's records into this workspace.
// Lives in the Integrations page. Each connection picks a registered connector
// (companion app to start), holds an encrypted credential + a base URL, exposes a
// live webhook URL, and lets you toggle + reconcile each entity type.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, JsonField, useToast, useConfirm } from "@cobblr/platform-web";
import { api, ApiError, type SyncConnectorDef, type SyncConnection } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

type PlanAction = "create" | "update" | "link" | "unchanged" | "delete";
const ACTION_LABEL: Record<PlanAction, string> = {
  create: "create",
  link: "merge",
  update: "update",
  unchanged: "unchanged",
  delete: "remove",
};
const ACTION_BADGE: Record<PlanAction, string> = {
  create: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  link: "border-blue-500/50 text-blue-700 dark:text-blue-400",
  update: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  unchanged: "border-line dark:border-slate-700 text-faint dark:text-slate-500",
  delete: "border-ember-500/50 text-ember-700 dark:text-ember-400",
};
const ACTION_TEXT: Record<PlanAction, string> = {
  create: "text-emerald-600 dark:text-emerald-400",
  link: "text-blue-600 dark:text-blue-400",
  update: "text-amber-600 dark:text-amber-400",
  unchanged: "text-faint dark:text-slate-500",
  delete: "text-ember-600 dark:text-ember-400",
};

export function SyncConnectionsSection() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const connectorsQ = useQuery({
    queryKey: ["sync-connectors", activeSlug],
    queryFn: () => api.listSyncConnectors(activeSlug),
    enabled: !!activeSlug,
  });
  const connectionsQ = useQuery({
    queryKey: ["sync-connections", activeSlug],
    queryFn: () => api.listSyncConnections(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["sync-connections", activeSlug] });
  };

  const connectors = connectorsQ.data?.items ?? [];
  const connections = connectionsQ.data?.items ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-mono uppercase tracking-widest text-accent">// Live sync</h2>
          <p className="text-[11px] text-muted dark:text-slate-400 mt-0.5">
            Mirror records from another system into this workspace — they arrive instantly via webhook, with a reconcile that backstops anything missed.
          </p>
        </div>
        {connectors.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs px-2.5 py-1 rounded bg-cobble-600 text-white hover:bg-cobble-700 transition shrink-0"
          >
            + Add connection
          </button>
        )}
      </div>

      {connections.length === 0 ? (
        <div className="text-[11px] text-faint italic border border-dashed border-line dark:border-slate-700 rounded-lg px-3 py-4">
          No sync connections yet. {connectors.length > 0 ? 'Add one to mirror an external system in.' : 'No sync connectors are installed.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {connections.map((c) => (
            <SyncConnectionCard key={c.id} conn={c} onChange={invalidate} />
          ))}
        </ul>
      )}

      {adding && (
        <AddSyncConnectionModal
          connectors={connectors}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            invalidate();
            toast.success("Connection added — enable a sync to start mirroring.");
          }}
        />
      )}
    </section>
  );
}

function SyncConnectionCard({ conn, onChange }: { conn: SyncConnection; onChange: () => void }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ["sync-connection", activeSlug, conn.id],
    queryFn: () => api.getSyncConnection(activeSlug, conn.id),
    enabled: !!activeSlug,
    refetchInterval: 10_000, // pick up sync status as the worker runs
  });
  const detail = detailQ.data;

  const test = useMutation({
    mutationFn: () => api.testSyncConnection(activeSlug, conn.id),
    onSuccess: (r) => (r.ok ? toast.success("Connection OK") : toast.error(r.error ?? "Test failed")),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const configure = useMutation({
    mutationFn: (v: { entityType: string; enabled: boolean }) =>
      api.configureSync(activeSlug, conn.id, v.entityType, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug, conn.id] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const run = useMutation({
    mutationFn: (entityType: string) => api.runSync(activeSlug, conn.id, entityType),
    onSuccess: (r) => {
      if (r.ok && r.result) {
        const { created, updated, tombstoned } = r.result;
        toast.success(`Synced — ${created} new, ${updated} updated, ${tombstoned} removed`);
      } else toast.error(r.error ?? "Sync failed");
      void qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug, conn.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: () => api.deleteSyncConnection(activeSlug, conn.id),
    onSuccess: () => {
      toast.success("Connection removed");
      onChange();
    },
  });

  // First-import preview/approve flow (per entity type).
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const previewQ = useQuery({
    queryKey: ["sync-preview", activeSlug, conn.id, previewKey],
    queryFn: () => api.previewSyncImport(activeSlug, conn.id, previewKey!),
    enabled: !!activeSlug && !!previewKey,
  });
  const doImport = useMutation({
    mutationFn: (entityType: string) => api.runSyncImport(activeSlug, conn.id, entityType),
    onSuccess: (r) => {
      if (r.ok && r.result) {
        const { created, linked, updated } = r.result;
        toast.success(`Imported — ${created} created, ${linked} merged, ${updated} updated. Live sync is on.`);
        setPreviewKey(null);
        void qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug, conn.id] });
      } else toast.error(r.error ?? "Import failed");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const previewLabel = detail?.entity_types?.find((t) => t.key === previewKey)?.label ?? previewKey ?? "";

  const webhookUrl = detail?.webhook_path ? `${window.location.origin}${detail.webhook_path}` : null;

  return (
    <li className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-content dark:text-mortar-100">{conn.label}</span>
        <span className="text-[10px] font-mono text-faint">{conn.connector_id}</span>
        <span className="text-[11px] font-mono text-muted dark:text-slate-400 truncate">{conn.config.base_url}</span>
        <div className="flex-1" />
        <button onClick={() => test.mutate()} disabled={test.isPending} className="text-[11px] text-accent hover:underline">
          {test.isPending ? "Testing…" : "Test"}
        </button>
        <button
          onClick={async () => {
            if (await confirm({ title: "Remove connection?", message: "Mirrored records stay; the link stops." })) del.mutate();
          }}
          className="text-[11px] text-ember-600 dark:text-ember-400 hover:underline"
        >
          Remove
        </button>
      </div>

      {/* Per-entity-type sync rows */}
      <div className="space-y-1.5">
        {(detail?.entity_types ?? []).map((t) => {
          const state = detail?.syncs?.find((s) => s.entity_type === t.key);
          const approved = !!state?.import_approved_at;
          const enabled = !!state?.enabled;
          // Before the first import is approved: preview-then-import. After: the
          // live toggle + sync-now.
          if (!approved) {
            return (
              <div key={t.key} className="flex items-center gap-2 text-xs">
                <span className="text-content dark:text-mortar-100">{t.label}</span>
                <span className="text-[9px] font-mono uppercase tracking-wider text-faint dark:text-slate-500 border border-line dark:border-slate-700 rounded px-1 py-px">
                  not imported
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => setPreviewKey(t.key)}
                  className="text-[11px] text-accent hover:underline shrink-0"
                >
                  Preview import →
                </button>
              </div>
            );
          }
          return (
            <div key={t.key} className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => configure.mutate({ entityType: t.key, enabled: e.target.checked })}
                />
                <span className="text-content dark:text-mortar-100">{t.label}</span>
                <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  {enabled ? "live" : "paused"}
                </span>
              </label>
              <div className="flex-1" />
              {state?.last_run_at && (
                <span className={`text-[10px] ${state.last_status === "error" ? "text-ember-500" : "text-faint"}`}>
                  {state.last_status === "error"
                    ? `error: ${state.last_error ?? "?"}`
                    : `${state.last_synced_count ?? 0} synced`}
                </span>
              )}
              <button
                onClick={() => run.mutate(t.key)}
                disabled={run.isPending}
                className="text-[11px] text-accent hover:underline shrink-0"
              >
                {run.isPending ? "Syncing…" : "Sync now"}
              </button>
            </div>
          );
        })}
      </div>

      {/* The live webhook URL — paste into the source system. */}
      {webhookUrl && (
        <div className="text-[10px] text-faint">
          <span className="uppercase tracking-widest">Live webhook</span>{" "}
          <code className="font-mono text-muted dark:text-slate-400 break-all">{webhookUrl}</code>{" "}
          <button onClick={() => void navigator.clipboard.writeText(webhookUrl).then(() => toast.success("Copied"))} className="text-accent hover:underline">
            copy
          </button>
        </div>
      )}

      {/* First-import preview: what a one-time pull WOULD do, before committing. */}
      {previewKey && (
        <Modal open onClose={() => setPreviewKey(null)} title={`Import preview — ${previewLabel}`} size="md">
          {previewQ.isFetching && !previewQ.data && (
            <div className="text-sm text-muted dark:text-slate-400 py-6 text-center">Pulling from the source…</div>
          )}
          {previewQ.data && !previewQ.data.ok && (
            <div className="text-sm text-ember-600 dark:text-ember-400 py-4">Preview failed: {previewQ.data.error}</div>
          )}
          {previewQ.data?.plan && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {(["create", "link", "update", "unchanged", "delete"] as const)
                  .filter((a) => previewQ.data!.plan!.counts[a] > 0)
                  .map((a) => (
                    <span key={a} className={`text-[11px] px-2 py-0.5 rounded border ${ACTION_BADGE[a]}`}>
                      {previewQ.data!.plan!.counts[a]} {ACTION_LABEL[a]}
                    </span>
                  ))}
                {previewQ.data.plan.counts.total === 0 && (
                  <span className="text-[11px] text-muted dark:text-slate-400">Nothing to import — the source is empty.</span>
                )}
              </div>
              <div className="max-h-72 overflow-auto rounded-lg border border-line dark:border-slate-700">
                {previewQ.data.plan.items.map((it) => (
                  <div
                    key={`${it.action}:${it.externalId}`}
                    className="flex items-center gap-2 px-2.5 py-1 text-xs border-b border-line/40 dark:border-slate-700/40 last:border-0"
                  >
                    <span className={`text-[9px] font-mono uppercase w-16 shrink-0 ${ACTION_TEXT[it.action]}`}>
                      {ACTION_LABEL[it.action]}
                    </span>
                    <span className="text-content dark:text-mortar-100 truncate">{it.name}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted dark:text-slate-400">
                <strong>Merge</strong> links a source record to a same-name item already in this workspace instead of
                duplicating it. After import, this entity type keeps syncing live.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setPreviewKey(null)}
                  className="text-xs px-3 py-1.5 rounded border border-line dark:border-slate-700 text-muted hover:text-content"
                >
                  Cancel
                </button>
                <button
                  onClick={() => doImport.mutate(previewKey)}
                  disabled={doImport.isPending || previewQ.data.plan.counts.total === 0}
                  className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-60"
                >
                  {doImport.isPending ? "Importing…" : "Approve & import"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </li>
  );
}

function AddSyncConnectionModal({
  connectors,
  onClose,
  onCreated,
}: {
  connectors: SyncConnectorDef[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const [label, setLabel] = useState(connectors[0]?.label ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [credsJsonMode, setCredsJsonMode] = useState(false);
  const [credsValid, setCredsValid] = useState(true);
  const [transport, setTransport] = useState<"direct" | "edge">("direct");
  const [bridge, setBridge] = useState("");

  const def = connectors.find((c) => c.id === connectorId);
  // A JSON Schema for the connector's credentials, derived from its descriptor —
  // so the "paste JSON" mode validates shape (right keys, all strings) inline.
  const credsSchema = def
    ? {
        type: "object",
        properties: Object.fromEntries(Object.keys(def.credentials).map((k) => [k, { type: "string" }])),
        required: Object.keys(def.credentials),
        additionalProperties: false,
      }
    : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.createSyncConnection(activeSlug, {
        connector_id: connectorId,
        label: label.trim() || (def?.label ?? "Connection"),
        base_url: baseUrl.trim(),
        credentials: creds,
        transport,
        bridge: transport === "edge" ? bridge.trim() || null : null,
      }),
    onSuccess: onCreated,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add a sync connection" size="sm">
      <div className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Connector</span>
          <select
            value={connectorId}
            onChange={(e) => {
              setConnectorId(e.target.value);
              const d = connectors.find((c) => c.id === e.target.value);
              if (d && !label) setLabel(d.label);
            }}
            className="input"
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="input" placeholder={def?.label} />
        </label>
        {def && Object.entries(def.config).map(([key, cfg]) => (
          <label key={key} className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">{cfg.label}</span>
            <input
              value={key === "base_url" ? baseUrl : ""}
              onChange={(e) => key === "base_url" && setBaseUrl(e.target.value)}
              className="input font-mono"
              placeholder={cfg.placeholder}
            />
          </label>
        ))}
        {/* Transport: direct (cloud fetches the URL) vs edge (a local bridge does). */}
        <div>
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">How does Cobblr reach it?</span>
          <div className="flex gap-2">
            {(["direct", "edge"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTransport(t)}
                className={
                  "text-xs px-2.5 py-1.5 rounded border transition " +
                  (transport === t
                    ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/40 text-content dark:text-mortar-100"
                    : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-content")
                }
              >
                {t === "direct" ? "Direct" : "Via edge bridge"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted dark:text-slate-400">
            {transport === "direct"
              ? "The cloud fetches the URL itself. On the hosted service this only works for public URLs — a LAN address won't be reachable."
              : "A local edge bridge on your network fetches the URL and relays it up — the way to connect a LAN source (like companion app) to hosted Cobblr."}
          </p>
          {transport === "edge" && (
            <input
              value={bridge}
              onChange={(e) => setBridge(e.target.value)}
              className="input font-mono mt-2"
              placeholder="bridge name (optional — blank = workspace default)"
            />
          )}
        </div>
        {def && Object.keys(def.credentials).length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint">Credentials</span>
              <button
                type="button"
                onClick={() => setCredsJsonMode((m) => !m)}
                className="text-[10px] text-accent hover:underline"
              >
                {credsJsonMode ? "← fields" : "paste JSON →"}
              </button>
            </div>
            {credsJsonMode ? (
              <JsonField
                value={creds}
                onChange={(v, m) => {
                  setCredsValid(m.valid);
                  if (m.valid) setCreds((v as Record<string, string>) ?? {});
                }}
                schema={credsSchema}
                rows={5}
                placeholder={`{\n  ${Object.keys(def.credentials).map((k) => `"${k}": ""`).join(",\n  ")}\n}`}
                hint="Paste the credentials object — validated against the connector's shape."
              />
            ) : (
              <div className="space-y-2">
                {Object.entries(def.credentials).map(([key, c]) => (
                  <label key={key} className="block">
                    <span className="block text-[10px] font-mono text-faint mb-0.5">{c.label}</span>
                    <input
                      type={c.secret ? "password" : "text"}
                      value={creds[key] ?? ""}
                      onChange={(e) => setCreds((p) => ({ ...p, [key]: e.target.value }))}
                      className="input font-mono"
                      autoComplete="off"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs text-muted dark:text-slate-400">Cancel</button>
          <button
            onClick={() => create.mutate()}
            disabled={!connectorId || !baseUrl.trim() || (credsJsonMode && !credsValid) || create.isPending}
            className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 transition"
          >
            {create.isPending ? "Adding…" : "Add connection"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
