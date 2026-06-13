// /me/connections — personal (user-scoped) connections manager.
//
// Configure a BYO AI provider (your own Ollama / OpenAI / Anthropic key, or the
// local-AI edge bridge) ONCE, then route it to chosen workspaces so it follows
// you instead of being re-added per workspace. Secrets are write-only — the
// list shows which keys are set, never the values.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plug, Plus, Trash2, X } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type AiProviderDef,
  type ConnRouteMode,
  type ConnRouteScope,
  type OrgMembership,
  type UserConnection,
  type UserConnectionInput,
} from "../lib/api";

const MODE_LABEL: Record<ConnRouteMode, string> = {
  "my-calls": "Only calls I personally make",
  "workspace-default": "Everyone + automations in the workspace",
};
const SCOPE_LABEL: Record<ConnRouteScope, string> = {
  sole_member: "Workspaces where I'm the only member",
  owner: "Workspaces I own",
  all_mine: "All my workspaces",
  explicit: "Specific workspaces",
};

export function ConnectionsPage() {
  usePageTitle("Connections");
  const qc = useQueryClient();
  const toast = useToast();
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const catalogue = useQuery({ queryKey: ["conn-catalogue"], queryFn: api.connectionCatalogue });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserConnection | null>(null);

  const orgs = me.data?.orgs ?? [];
  const providers = catalogue.data?.items ?? [];
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

  const del = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      toast.success("Connection removed.");
      void qc.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Link to="/me" className="text-sm text-muted hover:text-accent inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Profile
        </Link>
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <Plug size={20} className="text-accent" /> Connections
        </h1>
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Set up a personal AI provider — your own key, or the local-AI edge bridge — once,
        and route it to the workspaces you choose. It follows you instead of being
        re-added per workspace. Secrets are stored encrypted and never shown again.
      </p>

      {conns.isLoading && <div className="text-sm text-faint">loading…</div>}
      {!conns.isLoading && (conns.data?.items.length ?? 0) === 0 && !adding && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <Plug size={26} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">No personal connections yet.</div>
        </div>
      )}

      <div className="space-y-2">
        {(conns.data?.items ?? []).map((c) => (
          <div
            key={c.id}
            className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex items-start gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-content dark:text-mortar-100">
                {c.label || providerLabel(c.provider_id)}
                <span className="ml-2 text-[11px] font-mono text-faint">{c.provider_id}</span>
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {MODE_LABEL[c.route_mode]} · {SCOPE_LABEL[c.route_scope]}
                {c.route_scope === "explicit" &&
                  c.org_ids.length > 0 &&
                  `: ${c.org_ids.map(orgName).join(", ")}`}
                {c.route_scope === "explicit" && c.auto_enable_new && " · auto-adds new workspaces"}
              </div>
              {c.credential_keys.length > 0 && (
                <div className="text-[11px] text-faint mt-0.5">
                  set: {c.credential_keys.join(", ")}
                </div>
              )}
            </div>
            <div className="flex items-center shrink-0">
              <button
                type="button"
                onClick={() => {
                  setEditing(c);
                  setAdding(false);
                }}
                className="text-faint hover:text-accent p-1.5"
                title="Edit routing"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => del.mutate(c.id)}
                className="text-faint hover:text-ember-500 p-1.5"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding || editing ? (
        <ConnectionForm
          key={editing?.id ?? "new"}
          providers={providers}
          orgs={orgs}
          existing={editing}
          onDone={() => {
            setAdding(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["connections"] });
          }}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5"
        >
          <Plus size={15} /> Add a connection
        </button>
      )}

      <RavelryCard orgs={orgs} />
    </div>
  );
}

// ─── Ravelry: connect a read-only Ravelry account, then import your stash +
//     projects into a workspace's Yarn bundle (feedback a713b84c). ───────────
function RavelryCard({ orgs }: { orgs: OrgMembership[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["ravelry-status"], queryFn: api.meRavelryStatus });
  const [accessKey, setAccessKey] = useState("");
  const [personalKey, setPersonalKey] = useState("");
  const [target, setTarget] = useState("");

  const connected = status.data?.connected ?? false;

  const connect = useMutation({
    mutationFn: () => api.meRavelryConnect({ access_key: accessKey.trim(), personal_key: personalKey.trim() }),
    onSuccess: (r) => {
      setAccessKey("");
      setPersonalKey("");
      toast.success(`Connected as ${r.username}`);
      void qc.invalidateQueries({ queryKey: ["ravelry-status"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't connect to Ravelry"),
  });

  const disconnect = useMutation({
    mutationFn: () => api.meRavelryDisconnect(),
    onSuccess: () => {
      toast.success("Ravelry disconnected");
      void qc.invalidateQueries({ queryKey: ["ravelry-status"] });
    },
  });

  const runImport = useMutation({
    mutationFn: () => api.ravelryImport(target),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.stash.created || r.stash.updated)
        parts.push(`yarn: ${r.stash.created} added${r.stash.updated ? `, ${r.stash.updated} updated` : ""}`);
      if (r.designs_imported && (r.designs.created || r.designs.updated))
        parts.push(`designs: ${r.designs.created} added${r.designs.updated ? `, ${r.designs.updated} updated` : ""}`);
      if (r.errors) parts.push(`${r.errors} skipped`);
      toast.success(parts.length ? `Imported — ${parts.join(" · ")}` : "Nothing new to import");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Import failed"),
  });

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🧶</span>
        <h2 className="text-sm font-medium text-content dark:text-slate-200 flex-1">Ravelry</h2>
        {connected && status.data?.username && (
          <span className="text-[11px] text-muted">
            connected as <span className="font-medium text-content dark:text-slate-300">{status.data.username}</span>
          </span>
        )}
      </div>

      {!connected ? (
        <>
          <p className="text-xs text-muted dark:text-slate-400">
            Import your Ravelry stash + projects into a Yarn workspace. Create a read-only personal API
            key at{" "}
            <a
              href="https://www.ravelry.com/pro/developer"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              ravelry.com/pro/developer
            </a>{" "}
            → “Personal” → it gives you a username (access key) + password (personal key). Stored
            encrypted, used only to read your own data.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              placeholder="Access key (username)"
              autoComplete="off"
              className="rounded border border-line dark:border-slate-700 bg-canvas dark:bg-slate-950 px-2 py-1.5 text-sm"
            />
            <input
              value={personalKey}
              onChange={(e) => setPersonalKey(e.target.value)}
              placeholder="Personal key (password)"
              type="password"
              autoComplete="off"
              className="rounded border border-line dark:border-slate-700 bg-canvas dark:bg-slate-950 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!accessKey.trim() || !personalKey.trim() || connect.isPending}
              onClick={() => connect.mutate()}
              className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
            >
              {connect.isPending ? "Connecting…" : "Connect Ravelry"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted dark:text-slate-400">
            Import your stash into a workspace’s <span className="font-medium">Yarn</span> table (and
            your projects into <span className="font-medium">Designs</span>, if that feature is on).
            Re-running updates what’s already there instead of duplicating.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded border border-line dark:border-slate-700 bg-canvas dark:bg-slate-950 px-2 py-1.5 text-sm"
            >
              <option value="">Choose a workspace…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!target || runImport.isPending}
              onClick={() => runImport.mutate()}
              className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
            >
              {runImport.isPending ? "Importing…" : "Import now"}
            </button>
            <button
              type="button"
              onClick={() => disconnect.mutate()}
              className="text-[11px] text-faint hover:text-ember-500 ml-auto"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function ConnectionForm({
  providers,
  orgs,
  existing,
  onDone,
  onCancel,
}: {
  providers: AiProviderDef[];
  orgs: Array<{ id: string; name: string; role: string }>;
  existing: UserConnection | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const isEdit = !!existing;
  const [providerId, setProviderId] = useState(existing?.provider_id ?? providers[0]?.id ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<ConnRouteMode>(existing?.route_mode ?? "my-calls");
  const [scope, setScope] = useState<ConnRouteScope>(existing?.route_scope ?? "sole_member");
  const [autoNew, setAutoNew] = useState(existing?.auto_enable_new ?? false);
  const [orgIds, setOrgIds] = useState<string[]>(existing?.org_ids ?? []);

  const provider = useMemo(() => providers.find((p) => p.id === providerId), [providers, providerId]);
  const credFields = Object.entries(provider?.credentials ?? {});

  const save = useMutation({
    mutationFn: async () => {
      const cleanCreds: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(creds)) if (v.trim() !== "") cleanCreds[k] = v;
      const routing = {
        route_mode: mode,
        route_scope: scope,
        auto_enable_new: scope === "explicit" ? autoNew : false,
        org_ids: scope === "explicit" ? orgIds : [],
      };
      if (isEdit) {
        // On edit, only send credentials the user actually re-entered (blank = keep).
        await api.updateConnection(existing!.id, {
          label: label.trim(),
          ...(Object.keys(cleanCreds).length ? { credentials: cleanCreds } : {}),
          ...routing,
        });
        return;
      }
      const body: UserConnectionInput = {
        provider_id: providerId,
        label: label.trim() || undefined,
        credentials: cleanCreds,
        ...routing,
        org_ids: scope === "explicit" ? orgIds : undefined,
      };
      await api.addConnection(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Connection updated." : "Connection added.");
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <section className="rounded-xl border border-cobble-300 dark:border-cobble-700 bg-cobble-50/40 dark:bg-cobble-900/15 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-content dark:text-slate-300 flex-1">
          {isEdit ? "Edit connection" : "Add a connection"}
        </h2>
        <button type="button" onClick={onCancel} className="text-faint hover:text-content p-1" title="Cancel">
          <X size={15} />
        </button>
      </div>

      <label className="block">
        <div className="text-xs text-muted mb-1">Provider</div>
        <select
          value={providerId}
          disabled={isEdit}
          onChange={(e) => {
            setProviderId(e.target.value);
            setCreds({});
          }}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 disabled:opacity-60"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <div className="text-xs text-muted mb-1">Label (optional)</div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. My home Ollama"
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>

      {credFields.map(([key, def]) => (
        <label key={key} className="block">
          <div className="text-xs text-muted mb-1">
            {def.label}
            {isEdit && existing?.credential_keys.includes(key) && (
              <span className="text-faint"> · set (leave blank to keep)</span>
            )}
          </div>
          <input
            type={def.secret ? "password" : "text"}
            value={creds[key] ?? ""}
            onChange={(e) => setCreds((m) => ({ ...m, [key]: e.target.value }))}
            autoComplete="off"
            placeholder={isEdit && existing?.credential_keys.includes(key) ? "•••••• (unchanged)" : ""}
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
          />
        </label>
      ))}
      {credFields.length === 0 && (
        <div className="text-[11px] text-faint italic">
          This provider needs no credentials — it routes to a device you connect (e.g. the edge bridge).
        </div>
      )}

      <label className="block">
        <div className="text-xs text-muted mb-1">Used for</div>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ConnRouteMode)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        >
          <option value="my-calls">{MODE_LABEL["my-calls"]} (safe — never shared)</option>
          <option value="workspace-default">{MODE_LABEL["workspace-default"]} (shares with co-members)</option>
        </select>
      </label>

      <label className="block">
        <div className="text-xs text-muted mb-1">In which workspaces</div>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as ConnRouteScope)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        >
          <option value="sole_member">{SCOPE_LABEL["sole_member"]}</option>
          <option value="owner">{SCOPE_LABEL["owner"]}</option>
          <option value="all_mine">{SCOPE_LABEL["all_mine"]}</option>
          <option value="explicit">{SCOPE_LABEL["explicit"]}</option>
        </select>
      </label>

      {scope === "explicit" && (
        <div className="rounded border border-line dark:border-slate-700 p-2 space-y-1">
          {orgs.length === 0 && <div className="text-[11px] text-faint">No workspaces.</div>}
          {orgs.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-content dark:text-mortar-200">
              <input
                type="checkbox"
                checked={orgIds.includes(o.id)}
                onChange={(e) =>
                  setOrgIds((ids) => (e.target.checked ? [...ids, o.id] : ids.filter((x) => x !== o.id)))
                }
                className="accent-cobble-500"
              />
              {o.name}
              <span className="text-[10px] text-faint">{o.role}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-200 pt-1 border-t border-line dark:border-slate-700 mt-1">
            <input
              type="checkbox"
              checked={autoNew}
              onChange={(e) => setAutoNew(e.target.checked)}
              className="accent-cobble-500"
            />
            Auto-add new workspaces I create
          </label>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={!providerId || save.isPending}
          onClick={() => save.mutate()}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Save connection"}
        </button>
      </div>
    </section>
  );
}
