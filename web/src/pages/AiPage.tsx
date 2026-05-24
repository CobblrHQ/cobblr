// /configuration/ai — providers, capability defaults, usage.
//
// Three sections:
//   - Providers: which AI APIs the workspace can call (OpenAI,
//     Anthropic, Ollama). Same shape as integrations connectors.
//   - Capability defaults: for each capability (classify-image,
//     summarise, ...), which provider + model the workspace picks
//     by default.
//   - Usage: this-month spend + per-capability breakdown + recent
//     calls.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type AiProvider,
  type AiProviderDef,
  type AiCapabilityDefault,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function AiPage() {
  const { activeSlug } = useActiveOrg();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [editingCapability, setEditingCapability] = useState<string | null>(null);

  const catalogueQ = useQuery({
    queryKey: ["ai-catalogue", activeSlug],
    queryFn: () => api.listAiProviderCatalogue(activeSlug),
    enabled: !!activeSlug,
  });
  const providersQ = useQuery({
    queryKey: ["ai-providers", activeSlug],
    queryFn: () => api.listAiProviders(activeSlug),
    enabled: !!activeSlug,
  });
  const capDefaultsQ = useQuery({
    queryKey: ["ai-capability-defaults", activeSlug],
    queryFn: () => api.listAiCapabilityDefaults(activeSlug),
    enabled: !!activeSlug,
  });
  const summaryQ = useQuery({
    queryKey: ["ai-usage-summary", activeSlug],
    queryFn: () => api.getAiUsageSummary(activeSlug),
    enabled: !!activeSlug,
  });
  const callsQ = useQuery({
    queryKey: ["ai-calls", activeSlug],
    queryFn: () => api.listAiCalls(activeSlug, 25),
    enabled: !!activeSlug,
  });

  const defByPid = useMemo(() => {
    const m = new Map<string, AiProviderDef>();
    for (const d of catalogueQ.data?.items ?? []) m.set(d.id, d);
    return m;
  }, [catalogueQ.data]);

  const capDefaultsByCapability = useMemo(() => {
    const m = new Map<string, AiCapabilityDefault>();
    for (const r of capDefaultsQ.data?.items ?? []) m.set(r.capability, r);
    return m;
  }, [capDefaultsQ.data]);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/configuration"
            className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" /> Configuration
          </Link>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> AI
          </h1>
        </div>
      </header>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">Providers</h2>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white"
          >
            <Plus className="h-4 w-4" /> Add provider
          </button>
        </div>
        <div className="space-y-2">
          {providersQ.data?.items.length === 0 && (
            <div className="text-sm text-slate-500 border border-dashed rounded p-4">
              No AI providers configured. Add one to start using
              capabilities like classify-image and match-to-catalog.
            </div>
          )}
          {providersQ.data?.items.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              def={defByPid.get(p.provider_id) ?? null}
              onEdit={() => setEditing(p)}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Capability defaults</h2>
        <div className="text-xs text-slate-500 mb-2">
          For each capability, which provider + model the workspace
          uses by default. Wires fire capabilities through these.
        </div>
        <div className="space-y-1">
          {capDefaultsQ.data?.all_capabilities.map((cap) => {
            const row = capDefaultsByCapability.get(cap);
            return (
              <div
                key={cap}
                className="flex items-center justify-between border-b py-2 last:border-0 dark:border-slate-700"
              >
                <div className="font-mono text-sm">{cap}</div>
                <div className="flex items-center gap-2 text-sm">
                  {row ? (
                    <span>
                      <span className="text-slate-500">{row.provider_id}</span>
                      <span className="mx-1 text-slate-400">·</span>
                      <span className="font-mono">{row.model}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400 italic">unset</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingCapability(cap)}
                    className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">This month</h2>
        {summaryQ.data?.items.length === 0 && (
          <div className="text-sm text-slate-500">No AI calls yet this month.</div>
        )}
        <div className="space-y-1">
          {summaryQ.data?.items.map((s) => (
            <div
              key={`${s.capability}:${s.provider_id}`}
              className="flex items-center justify-between text-sm border-b py-1 last:border-0 dark:border-slate-700"
            >
              <div>
                <span className="font-mono">{s.capability}</span>
                <span className="mx-1 text-slate-400">·</span>
                <span className="text-slate-500">{s.provider_id}</span>
              </div>
              <div className="text-slate-500 text-xs">
                {s.calls} calls
                {Number(s.cached_calls) > 0 && (
                  <span> ({s.cached_calls} cached)</span>
                )}
                {Number(s.failed) > 0 && (
                  <span className="text-red-500"> · {s.failed} failed</span>
                )}
                {" · "}
                {((Number(s.total_cost_cents ?? 0)) / 100).toFixed(2)}{" "}
                <span className="text-slate-400">USD</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Recent calls</h2>
        <div className="text-xs font-mono space-y-1">
          {callsQ.data?.items.length === 0 && (
            <div className="text-sm text-slate-500">No calls yet.</div>
          )}
          {callsQ.data?.items.map((c) => (
            <div key={c.id} className="flex gap-3 items-center">
              <span className={c.ok ? "text-emerald-600" : "text-red-600"}>
                {c.ok ? "ok" : "err"}
              </span>
              {c.cached && <span className="text-blue-500">cached</span>}
              <span className="font-medium">{c.capability}</span>
              <span className="text-slate-500">{c.provider_id}</span>
              <span className="text-slate-500">{c.model ?? "—"}</span>
              <span className="text-slate-400">
                {c.cost_cents !== null ? `${(c.cost_cents / 100).toFixed(2)}¢` : "—"} ·{" "}
                {c.duration_ms ?? "—"}ms
              </span>
              <span className="text-slate-400">
                {new Date(c.invoked_at).toLocaleString()}
              </span>
              {c.error && <span className="text-red-500 truncate">{c.error}</span>}
            </div>
          ))}
        </div>
      </section>

      {adding && catalogueQ.data && (
        <ProviderAddModal
          catalogue={catalogueQ.data.items}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && defByPid.get(editing.provider_id) && (
        <ProviderEditModal
          provider={editing}
          def={defByPid.get(editing.provider_id)!}
          onClose={() => setEditing(null)}
        />
      )}
      {editingCapability && (
        <CapabilityDefaultModal
          capability={editingCapability}
          providers={providersQ.data?.items ?? []}
          catalogue={catalogueQ.data?.items ?? []}
          existing={capDefaultsByCapability.get(editingCapability) ?? null}
          onClose={() => setEditingCapability(null)}
        />
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  def,
  onEdit,
}: {
  provider: AiProvider;
  def: AiProviderDef | null;
  onEdit: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const testM = useMutation({
    mutationFn: () => api.testAiProvider(activeSlug, provider.id),
    onSuccess: (r) =>
      r.ok ? toast.success(r.note ?? "Test passed.") : toast.error(r.error ?? "Test failed."),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const delM = useMutation({
    mutationFn: () => api.deleteAiProvider(activeSlug, provider.id),
    onSuccess: () => {
      toast.success("Provider removed.");
      void qc.invalidateQueries({ queryKey: ["ai-providers", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["ai-capability-defaults", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const toggleM = useMutation({
    mutationFn: () =>
      api.updateAiProvider(activeSlug, provider.id, { enabled: !provider.enabled }),
    onSuccess: () => {
      toast.success(provider.enabled ? "Disabled." : "Enabled.");
      void qc.invalidateQueries({ queryKey: ["ai-providers", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="border rounded p-3 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="font-medium truncate">{provider.label}</div>
          <div className="text-xs text-slate-500">
            {def?.label ?? provider.provider_id}
            {!provider.enabled && (
              <span className="ml-2 text-amber-600">disabled</span>
            )}
            {provider.monthly_budget_cents !== null && (
              <span className="ml-2">
                budget: ${(provider.monthly_budget_cents / 100).toFixed(2)} / month
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => testM.mutate()}
            disabled={testM.isPending}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Test connection"
          >
            <Play className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Edit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleM.mutate()}
            disabled={toggleM.isPending}
            className="px-2 py-1 text-xs rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {provider.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await confirm({
                title: "Remove provider?",
                message: `${provider.label} will be removed. Wires using its capabilities will fail until you reconfigure.`,
                confirmLabel: "Remove",
                destructive: true,
              });
              if (ok) delM.mutate();
            }}
            className="p-1.5 text-red-500 hover:text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/40"
            title="Remove"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderAddModal({
  catalogue,
  onClose,
}: {
  catalogue: AiProviderDef[];
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [pickedId, setPickedId] = useState(catalogue[0]?.id ?? "");
  const picked = catalogue.find((c) => c.id === pickedId);
  const [label, setLabel] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState<string>("");

  const createM = useMutation({
    mutationFn: () =>
      api.createAiProvider(activeSlug, {
        provider_id: pickedId,
        label: label.trim() || picked?.label || pickedId,
        credentials: creds,
        monthly_budget_cents: budget.trim() === "" ? null : Math.round(Number(budget) * 100),
      }),
    onSuccess: () => {
      toast.success("Provider added.");
      void qc.invalidateQueries({ queryKey: ["ai-providers", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add AI provider" size="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          createM.mutate();
        }}
      >
        <div>
          <label className="block text-sm font-medium mb-1">Provider</label>
          <select
            value={pickedId}
            onChange={(e) => {
              setPickedId(e.target.value);
              setCreds({});
            }}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            {catalogue.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {picked && (
            <div className="text-xs text-slate-500 mt-1">
              Supports: {Object.keys(picked.capabilities).join(", ")}
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={picked?.label ?? ""}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900"
          />
        </div>
        {picked &&
          Object.entries(picked.credentials).map(([key, d]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{d.label}</label>
              <input
                type={d.secret ? "password" : "text"}
                value={creds[key] ?? ""}
                onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          ))}
        <div>
          <label className="block text-sm font-medium mb-1">
            Monthly budget USD (optional)
          </label>
          <input
            type="number"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="e.g. 10.00"
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createM.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {createM.isPending ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProviderEditModal({
  provider,
  def,
  onClose,
}: {
  provider: AiProvider;
  def: AiProviderDef;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState(provider.label);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [updateCreds, setUpdateCreds] = useState(false);
  const [budget, setBudget] = useState<string>(
    provider.monthly_budget_cents !== null
      ? (provider.monthly_budget_cents / 100).toFixed(2)
      : "",
  );

  const saveM = useMutation({
    mutationFn: () =>
      api.updateAiProvider(activeSlug, provider.id, {
        label: label.trim() || provider.label,
        credentials: updateCreds ? creds : undefined,
        monthly_budget_cents:
          budget.trim() === "" ? null : Math.round(Number(budget) * 100),
      }),
    onSuccess: () => {
      toast.success("Provider updated.");
      void qc.invalidateQueries({ queryKey: ["ai-providers", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Edit ${provider.label}`} size="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          saveM.mutate();
        }}
      >
        <div>
          <label className="block text-sm font-medium mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            Monthly budget USD (blank = unlimited)
          </label>
          <input
            type="number"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={updateCreds}
            onChange={(e) => setUpdateCreds(e.target.checked)}
          />
          Replace credentials
        </label>
        {updateCreds &&
          Object.entries(def.credentials).map(([key, d]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{d.label}</label>
              <input
                type={d.secret ? "password" : "text"}
                value={creds[key] ?? ""}
                onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saveM.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {saveM.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CapabilityDefaultModal({
  capability,
  providers,
  catalogue,
  existing,
  onClose,
}: {
  capability: string;
  providers: AiProvider[];
  catalogue: AiProviderDef[];
  existing: AiCapabilityDefault | null;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // Providers that actually support this capability.
  const eligible = providers.filter((p) => {
    const def = catalogue.find((d) => d.id === p.provider_id);
    return def && def.capabilities[capability as never] !== undefined && p.enabled;
  });
  const [providerId, setProviderId] = useState(existing?.provider_id ?? eligible[0]?.provider_id ?? "");
  const def = catalogue.find((d) => d.id === providerId);
  const supportedModels = (def?.capabilities[capability as never] as { models: string[] } | undefined)?.models ?? [];
  const [model, setModel] = useState(existing?.model ?? supportedModels[0] ?? "");

  const saveM = useMutation({
    mutationFn: () =>
      api.upsertAiCapabilityDefault(activeSlug, {
        capability,
        provider_id: providerId,
        model,
      }),
    onSuccess: () => {
      toast.success("Default saved.");
      void qc.invalidateQueries({ queryKey: ["ai-capability-defaults", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const clearM = useMutation({
    mutationFn: () => api.deleteAiCapabilityDefault(activeSlug, capability),
    onSuccess: () => {
      toast.success("Default cleared.");
      void qc.invalidateQueries({ queryKey: ["ai-capability-defaults", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Default for ${capability}`} size="md">
      {eligible.length === 0 ? (
        <div className="space-y-2">
          <div className="text-sm text-slate-500">
            No enabled provider currently supports this capability.
            Add one first.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveM.mutate();
          }}
        >
          <div>
            <label className="block text-sm font-medium mb-1">Provider</label>
            <select
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                const nextDef = catalogue.find((d) => d.id === e.target.value);
                const next = (nextDef?.capabilities[capability as never] as { models: string[] } | undefined)?.models ?? [];
                setModel(next[0] ?? "");
              }}
              className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              {eligible.map((p) => (
                <option key={p.id} value={p.provider_id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
            >
              {supportedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            {existing && (
              <button
                type="button"
                onClick={() => clearM.mutate()}
                disabled={clearM.isPending}
                className="px-3 py-1.5 text-sm rounded text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/40 mr-auto"
              >
                Clear default
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saveM.isPending}
              className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
            >
              {saveM.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
