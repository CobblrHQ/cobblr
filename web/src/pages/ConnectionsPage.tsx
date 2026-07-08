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
  type UserConnection,
  type UserConnectionInput,
} from "../lib/api";
import { isEdgeBridgeConnection } from "../lib/useMyEdgeBridge";

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
                {c.routes.length === 0 ? (
                  c.route_scope === "explicit" ? (
                    "Not used in any workspace"
                  ) : (
                    `${MODE_LABEL[c.route_mode]} · ${SCOPE_LABEL[c.route_scope]}`
                  )
                ) : (
                  <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
                    {c.routes.map((r) => {
                      const shared = r.mode === "workspace-default";
                      // Only 'shared' routes carry an approval state; 'just me'
                      // always works for the owner so it needs no badge.
                      const status = shared ? c.share_status[r.org_id] : undefined;
                      return (
                        <span key={r.org_id} className="inline-flex items-center gap-1">
                          {orgName(r.org_id)} ({shared ? "shared" : "just me"})
                          {status === "pending" && (
                            <span className="text-amber-600 dark:text-amber-500">
                              · awaiting owner approval
                            </span>
                          )}
                          {status === "approved" && <span className="text-faint">· approved</span>}
                          {status === "active" && (
                            <span className="text-emerald-600 dark:text-emerald-500">· active</span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                )}
              </div>
              {c.credential_keys.length > 0 && (
                <div className="text-[11px] text-faint mt-0.5">
                  set: {c.credential_keys.join(", ")}
                </div>
              )}
              {isEdgeBridgeConnection(c.provider_id) && <EdgeBridgeStatusRow />}
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
    </div>
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
  // Per-workspace routing: org_id → mode. Absence = "Off". Seeded from the
  // connection's saved routes; a dynamic-scope (legacy) connection seeds from
  // its global mode applied to whichever workspaces it currently reaches.
  const [perWs, setPerWs] = useState<Record<string, ConnRouteMode>>(() => {
    if (existing?.routes?.length) return Object.fromEntries(existing.routes.map((r) => [r.org_id, r.mode]));
    if (!existing) return {};
    // Legacy dynamic-scope connection: reconstruct which workspaces it currently
    // reaches from its scope, so editing doesn't silently drop the routing.
    const m = existing.route_mode;
    if (existing.route_scope === "all_mine") return Object.fromEntries(orgs.map((o) => [o.id, m]));
    if (existing.route_scope === "owner")
      return Object.fromEntries(orgs.filter((o) => o.role === "owner").map((o) => [o.id, m]));
    return Object.fromEntries(existing.org_ids.map((id) => [id, m]));
  });

  const provider = useMemo(() => providers.find((p) => p.id === providerId), [providers, providerId]);
  const credFields = Object.entries(provider?.credentials ?? {});

  const save = useMutation({
    mutationFn: async () => {
      const cleanCreds: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(creds)) if (v.trim() !== "") cleanCreds[k] = v;
      const routes = Object.entries(perWs).map(([org_id, mode]) => ({ org_id, mode }));
      if (isEdit) {
        // On edit, only send credentials the user actually re-entered (blank = keep).
        await api.updateConnection(existing!.id, {
          label: label.trim(),
          ...(Object.keys(cleanCreds).length ? { credentials: cleanCreds } : {}),
          routes,
        });
        return;
      }
      const body: UserConnectionInput = {
        provider_id: providerId,
        label: label.trim() || undefined,
        credentials: cleanCreds,
        routes,
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
          {def.choices ? (
            <>
              <select
                value={creds[key] ?? ""}
                onChange={(e) => setCreds((m) => ({ ...m, [key]: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              >
                {def.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {key === "transit" && (creds[key] ?? "").startsWith("bridge") && <PersonalAgentHint />}
            </>
          ) : (
            <input
              type={def.secret ? "password" : "text"}
              value={creds[key] ?? ""}
              onChange={(e) => setCreds((m) => ({ ...m, [key]: e.target.value }))}
              autoComplete="off"
              placeholder={isEdit && existing?.credential_keys.includes(key) ? "•••••• (unchanged)" : ""}
              className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
            />
          )}
        </label>
      ))}
      {credFields.length === 0 && (
        <div className="text-[11px] text-faint italic">
          This provider needs no credentials — it routes to a device you connect (e.g. the edge bridge).
        </div>
      )}

      <div>
        <div className="text-xs text-muted mb-1">Use this AI in each workspace</div>
        <div className="rounded border border-line dark:border-slate-700 divide-y divide-line dark:divide-slate-700">
          {orgs.length === 0 && <div className="text-[11px] text-faint p-2">No workspaces.</div>}
          {orgs.map((o) => {
            const cur = perWs[o.id]; // undefined = off
            const owns = o.role === "owner";
            const set = (m: ConnRouteMode | null) =>
              setPerWs((prev) => {
                const next = { ...prev };
                if (m === null) delete next[o.id];
                else next[o.id] = m;
                return next;
              });
            return (
              <div key={o.id} className="flex items-center gap-2 p-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-content dark:text-mortar-200 truncate">{o.name}</div>
                  {cur === "workspace-default" && !owns && (
                    <div className="text-[10px] text-amber-600 dark:text-amber-500">
                      Shared — the owner approves before others can use it. Your own calls work right away.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 rounded-md border border-line dark:border-slate-600 overflow-hidden text-[11px] font-medium">
                  {([
                    [null, "Off"],
                    ["my-calls", "Just me"],
                    ["workspace-default", "Share"],
                  ] as Array<[ConnRouteMode | null, string]>).map(([val, lbl]) => {
                    const activeSeg = (val ?? "off") === (cur ?? "off");
                    return (
                      <button
                        key={lbl}
                        type="button"
                        onClick={() => set(val)}
                        className={
                          "px-2.5 py-1 transition " +
                          (activeSeg
                            ? "bg-cobble-600 text-white"
                            : "bg-surface dark:bg-slate-900 text-muted hover:bg-subtle dark:hover:bg-slate-800")
                        }
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-faint mt-1">
          <span className="font-medium">Just me</span> = only your own AI calls here use it.{" "}
          <span className="font-medium">Share</span> = offer it to everyone in the workspace (the owner approves).
        </p>
      </div>

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

/** Live "is my personal edge agent connected?" line under the bridge-transit
 *  choice — the answer to "will my local URL actually work?". */
function PersonalAgentHint() {
  const agent = useQuery({ queryKey: ["me-edge-agent"], queryFn: api.getMyEdgeAgent, refetchInterval: 5000 });
  const on = agent.data?.connected ?? false;
  return (
    <div className={"flex items-center gap-2 text-[11px] mt-1 rounded border p-1.5 " + (on ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 text-moss-700 dark:text-moss-300" : "border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400")}>
      <span className={"w-1.5 h-1.5 rounded-full shrink-0 " + (on ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
      {on
        ? "Your personal edge agent is connected — calls to this endpoint will route through it to your LAN."
        : "No personal edge agent is connected yet. Calls will fail until one dials in — set it up like the Local-AI edge bridge agent (it serves every bridge-transit connection you add)."}
    </div>
  );
}

/** Compact live status for an edge-bridge connection in the list — same
 *  emerald/slate "online/offline" convention as the workspace device bridges
 *  (BridgePicker), so a personal bridge reads the same as a 3D-printer one. */
function EdgeBridgeStatusRow() {
  const agent = useQuery({ queryKey: ["me-edge-agent"], queryFn: api.getMyEdgeAgent, refetchInterval: 5000 });
  const on = agent.data?.connected ?? false;
  return (
    <div className="flex items-center gap-1.5 text-[11px] mt-1">
      <span className={"inline-block w-1.5 h-1.5 rounded-full " + (on ? "bg-emerald-500" : "bg-slate-400/60")} />
      <span className={on ? "text-emerald-600 dark:text-emerald-500" : "text-muted"}>
        Edge bridge {on ? "online" : "offline"}
      </span>
      {!on && <span className="text-faint">— start your bridge agent to use it</span>}
    </div>
  );
}
