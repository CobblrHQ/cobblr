// /configuration/ai — where a workspace's AI comes from, and what it costs.
//
// Ordered by the question a visitor actually has:
//   1. Is AI on here?             AiAvailabilityBanner — the SERVER's answer.
//   2. What's powering it?        SharedAiSection (personal connections routed
//                                 in) then the workspace's own keys.
//   3. What does each job use?    Capability defaults.
//   4. What has it cost?          This month + recent calls.
//
// Two bugs shaped this layout, both worth not repeating:
//
//   - The page answered "is AI configured" by counting WORKSPACE providers,
//     which is only one of the ways a workspace gets AI. A workspace whose AI
//     came from a shared personal connection was told "No AI providers
//     configured" while Ask Cobb worked fine. The banner now reads the same
//     canonical status every other AI surface reads, so this page cannot
//     disagree with the rest of the app.
//
//   - The owner's controls for WHICH shared AI is active (and for turning
//     sharing off) used to live on the /configuration hub and were dropped in
//     the sections revamp, leaving a workspace with two approved AIs no way to
//     switch. They live here now, next to everything else about AI.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { capabilityLabel } from "../lib/ai-capability-labels";
import {
  ApiError,
  api,
  type AiProvider,
  type AiProviderDef,
  type AiCapabilityDefault,
  type AiActivityItem,
  type WorkspaceAiOffer,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAiStatus } from "../components/AiStatusNotice";
import { PayloadView, usageLine } from "../components/PayloadView";
import { FEED_SCROLL, FEED_SCROLL_INNER } from "../lib/feed";

export function AiPage() {
  usePageTitle("AI");
  const { activeSlug, activeOrg } = useActiveOrg();
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
  // Is there any workspace-owned provider you could actually pin a job to? When
  // there isn't (e.g. AI is provided only by the plan), the pencil would open a
  // dead-end modal - so the row shows an inline hint instead (the author, 2026-07-31).
  const canPin = (cap: string): boolean =>
    (providersQ.data?.items ?? []).some(
      (p) => p.enabled && defByPid.get(p.provider_id)?.capabilities[cap as never] !== undefined,
    );

  return (
    <div className="space-y-6">
      {/* The SERVER's answer to "is AI usable here", same signal every other AI
          surface reads (AiOffNotice on scan / match / build). This page used to
          answer that question itself by counting workspace providers, which is
          only one of the ways a workspace gets AI — so it announced "No AI
          providers configured" on a workspace whose AI was working, powered by
          a shared personal connection. Reading the canonical status means this
          page cannot contradict the rest of the app again. */}
      <AiAvailabilityBanner />

      {/* ONE list of everything that can power AI here, whatever it came from.
          Splitting workspace keys from shared personal connections made the
          reader do the merge themselves, and it was the split that let the page
          claim "no providers" while a shared connection was serving every call. */}
      <ConnectionsSection
        slug={activeSlug}
        providers={providersQ.data?.items ?? []}
        defByPid={defByPid}
        onAdd={() => setAdding(true)}
        onEdit={setEditing}
      />

      <AutoPickPhotosSection
        slug={activeSlug}
        canEdit={activeOrg?.role === "owner" || activeOrg?.role === "admin"}
      />

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
          What each job uses
        </h2>
        <p className="text-xs text-faint mt-0.5 mb-1">
          Pin a job to a particular provider and model. Anything left on
          automatic uses whatever AI is available.
        </p>
        <div className="divide-y divide-line dark:divide-slate-700">
          {capDefaultsQ.data?.all_capabilities.map((cap) => {
            const row = capDefaultsByCapability.get(cap);
            return (
              <div key={cap} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-content dark:text-mortar-100">
                    {capabilityLabel(cap)}
                  </div>
                  <div className="text-[10px] font-mono text-faint truncate">{cap}</div>
                </div>
                <div className="flex items-center gap-2 text-sm shrink-0">
                  {row ? (
                    <span className="text-right">
                      <span className="text-muted">{row.provider_id}</span>
                      <span className="mx-1 text-faint">·</span>
                      <span className="font-mono text-xs">{row.model}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-faint">automatic</span>
                  )}
                  {row || canPin(cap) ? (
                    <button
                      type="button"
                      onClick={() => setEditingCapability(cap)}
                      aria-label={`Change what ${capabilityLabel(cap)} uses`}
                      className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  ) : (
                    // Nothing to pin to yet: an inline hint, not a dead-end modal.
                    <span
                      className="p-1.5 text-faint"
                      title="Runs on whatever AI is available (your Cobblr plan, if your subscription includes it). Add your own provider below to pin this job to a specific provider or model."
                    >
                      <Info className="h-4 w-4" />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100 mb-3">
          This month
        </h2>
        {summaryQ.data?.items.length === 0 ? (
          <p className="text-sm text-faint">No AI calls yet this month.</p>
        ) : (
          <>
            <MonthTotals items={summaryQ.data?.items ?? []} />
            <div className="mt-3 divide-y divide-line dark:divide-slate-700">
              {summaryQ.data?.items.map((s) => (
                <div
                  key={`${s.capability}:${s.provider_id}`}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-content dark:text-mortar-100 truncate">
                      {capabilityLabel(s.capability)}
                    </div>
                    <div className="text-[11px] text-faint">{s.provider_id}</div>
                  </div>
                  <div className="text-xs text-muted text-right shrink-0">
                    <div>
                      {s.calls} call{Number(s.calls) === 1 ? "" : "s"}
                      {Number(s.cached_calls) > 0 && (
                        <span className="text-faint"> · {s.cached_calls} cached</span>
                      )}
                      {Number(s.failed) > 0 && (
                        <span className="text-ember-500"> · {s.failed} failed</span>
                      )}
                    </div>
                    <div className="text-faint">
                      ${((Number(s.total_cost_cents ?? 0)) / 100).toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100 mb-2">
          Recent calls
        </h2>
        <div className={"text-xs font-mono space-y-1 overflow-x-auto " + FEED_SCROLL}>
          {callsQ.data?.items.length === 0 && (
            <div className="text-sm text-muted">No calls yet.</div>
          )}
          {callsQ.data?.items.map((c) => (
            <div key={c.id} className="flex gap-3 items-center">
              <span className={c.ok ? "text-emerald-600" : "text-red-600"}>
                {c.ok ? "ok" : "err"}
              </span>
              {c.cached && <span className="text-blue-500">cached</span>}
              <span className="font-medium">{c.capability}</span>
              <span className="text-muted">{c.provider_id}</span>
              <span className="text-muted">{c.model ?? "—"}</span>
              <span className="text-faint">
                {c.cost_cents !== null ? `${(c.cost_cents / 100).toFixed(2)}¢` : "—"} ·{" "}
                {c.duration_ms ?? "—"}ms
              </span>
              <span className="text-faint">
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

      <AiActivitySection slug={activeSlug} />
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
          <div className="text-xs text-muted">
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
            className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
            title="Test connection"
          >
            <Play className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 text-muted hover:text-content dark:hover:text-slate-200 rounded hover:bg-subtle dark:hover:bg-slate-800"
            title="Edit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => toggleM.mutate()}
            disabled={toggleM.isPending}
            className="px-2 py-1 text-xs rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          >
            {catalogue.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {picked && (
            <div className="text-xs text-muted mt-1">
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
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          />
        </div>
        {picked &&
          Object.entries(picked.credentials).map(([key, d]) => (
            <div key={key}>
              <label className="block text-sm font-medium mb-1">{d.label}</label>
              {d.choices ? (
                <>
                  <select
                    value={creds[key] ?? ""}
                    onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
                  >
                    {d.choices.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  {key === "transit" && (creds[key] ?? "").startsWith("bridge") && <WorkspaceBridgeHint />}
                </>
              ) : (
                <input
                  type={d.secret ? "password" : "text"}
                  value={creds[key] ?? ""}
                  onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
                />
              )}
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
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
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
            className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
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
              {d.choices ? (
                <>
                  <select
                    value={creds[key] ?? ""}
                    onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
                  >
                    {d.choices.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  {key === "transit" && (creds[key] ?? "").startsWith("bridge") && <WorkspaceBridgeHint />}
                </>
              ) : (
                <input
                  type={d.secret ? "password" : "text"}
                  value={creds[key] ?? ""}
                  onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
                />
              )}
            </div>
          ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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

  const aiStatus = useAiStatus();
  const planProvided = aiStatus?.available && aiStatus.source === "managed";
  return (
    <Modal open onClose={onClose} title={`Default for ${capability}`} size="md">
      {eligible.length === 0 ? (
        <div className="space-y-3">
          {existing ? (
            // Reachable only as a STALE pin: the provider this was pinned to is
            // gone/disabled, so the job fell back to automatic. Let them clear it.
            <>
              <div className="text-sm text-muted">
                This job was pinned to <span className="font-mono">{existing.provider_id}</span>, which isn't an enabled
                provider here anymore - so it's running on automatic. Clear the pin, or add that provider back below.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => clearM.mutate()}
                  disabled={clearM.isPending}
                  className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
                >
                  Clear pin
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-muted">
                {planProvided
                  ? "This job runs on your Cobblr plan's AI (automatic). To pin it to a specific provider or model, add your own key first."
                  : "No enabled provider supports this capability yet. Add a provider first."}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
              >
                Close
              </button>
            </>
          )}
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
              className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900"
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
              className="w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono"
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
              className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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

/** Is AI usable in this workspace, according to the server? Rendered at the top
 *  of the AI page so the page's own headline can never disagree with what the
 *  scan / match / build surfaces tell the same user. `reason` distinguishes an
 *  operator kill-switch and an entitlement problem from "nothing set up", which
 *  matters because only the last one is fixable on this page. */
function AiAvailabilityBanner() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useAiStatus();
  const canEdit = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const settingsQ = useQuery({
    queryKey: ["ai-settings", activeSlug],
    queryFn: () => api.getAiSettings(activeSlug),
    enabled: !!activeSlug,
  });
  const disabled = settingsQ.data?.ai_disabled ?? false;
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.updateAiSettings(activeSlug, { ai_disabled: next }),
    onSuccess: (r) => {
      toast.success(r.ai_disabled ? "AI turned off for this workspace." : "AI turned back on for this workspace.");
      void qc.invalidateQueries({ queryKey: ["ai-settings", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["ai-status", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  if (!status) return null;

  // Explain WHERE an "on" workspace's AI comes from, so "on" next to
  // "Nothing connected yet" below stops being a contradiction.
  const sourceNote =
    status.source === "managed"
      ? " It's provided by your Cobblr plan - add your own key below only if you want a specific provider or to track spend."
      : status.source === "personal"
        ? " It's running on your own personal connection."
        : status.source === "workspace"
          ? " It's using a key this workspace added."
          : "";
  const offReason =
    status.reason === "workspace_disabled"
      ? "You turned AI off for this workspace. A member's own personal connection would still work here."
      : status.reason === "operator_disabled"
        ? "An operator has turned AI off for this whole server."
        : status.reason === "not_entitled"
          ? "This workspace's plan does not include AI."
          : "Nothing is connected yet. Add a workspace key below, or share a personal connection from your account.";
  // When it's off but AI WOULD work if re-enabled (the plan or a connected
  // workspace key would serve it), say so plainly so the switch reads as a
  // choice, not a dead end.
  const enableHint =
    status.reason === "workspace_disabled" && status.source === "managed"
      ? "AI is available from your Cobblr plan - turn the switch below on to use it across this workspace."
      : status.reason === "workspace_disabled" && status.source === "workspace"
        ? "A provider is connected for this workspace - turn the switch below on to use it."
        : null;

  return (
    <div className="space-y-2">
      {status.available ? (
        <div className="flex items-center gap-2 rounded-xl border border-moss-200 dark:border-moss-800/60 bg-moss-50 dark:bg-moss-950/30 px-4 py-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
          <span className="text-sm text-content dark:text-mortar-100">AI is on in this workspace.{sourceNote}</span>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5">
          <div className="text-sm font-medium text-content dark:text-mortar-100">AI is off in this workspace.</div>
          <p className="text-xs text-muted dark:text-mortar-200 mt-0.5">{offReason}</p>
          {enableHint && (
            <p className="text-xs font-medium text-content dark:text-mortar-100 mt-1.5 flex items-start gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
              {enableHint}
            </p>
          )}
        </div>
      )}

      {canEdit && status.reason !== "operator_disabled" && (
        <label className="flex items-start gap-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={!disabled}
            disabled={toggle.isPending || settingsQ.isLoading}
            onChange={(e) => toggle.mutate(!e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-cobble-600 shrink-0"
          />
          <span className="min-w-0">
            <span className="text-sm text-content dark:text-mortar-100">Use AI in this workspace</span>
            <span className="block text-xs text-faint dark:text-slate-400">
              On, this workspace uses whatever AI is available - your Cobblr plan's, or a key you add below. Off, Cobblr
              runs in basic mode here and makes no AI calls on the workspace's behalf. Either way, a member who connects
              their OWN personal key can still use it here.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

/** Capability ids are machine names ("classify-image"). Show a human label with
 *  the id underneath, so the page reads as English while staying greppable. */

/** Month totals as three plain numbers. The per-capability rows below answer
 *  "where did it go"; this answers "how much", which is the first question. */
function MonthTotals({
  items,
}: {
  items: Array<{ calls: number | string; failed: number | string; total_cost_cents?: number | string | null }>;
}) {
  const n = (v: unknown) => Number(v ?? 0);
  const calls = items.reduce((a, s) => a + n(s.calls), 0);
  const failed = items.reduce((a, s) => a + n(s.failed), 0);
  const cost = items.reduce((a, s) => a + n(s.total_cost_cents), 0) / 100;
  const Tile = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div className="flex-1 min-w-[7rem] rounded-lg bg-subtle dark:bg-slate-800/60 px-3 py-2">
      <div className={"text-lg font-semibold " + (tone ?? "text-content dark:text-mortar-100")}>
        {value}
      </div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint">{label}</div>
    </div>
  );
  return (
    <div className="flex flex-wrap gap-2">
      <Tile label="calls" value={String(calls)} />
      <Tile label="spent" value={`$${cost.toFixed(2)}`} />
      <Tile
        label="failed"
        value={String(failed)}
        tone={failed > 0 ? "text-ember-500" : undefined}
      />
    </div>
  );
}

/** Personal connections routed INTO this workspace.
 *
 *  A workspace's AI very often comes from here rather than from a key the
 *  workspace owns: someone sets up their own provider (or a local-AI edge
 *  bridge) under their account and shares it in. This page had no idea those
 *  existed, so it rendered "No AI providers configured" on a workspace whose
 *  AI was working fine — the exact contradiction that surfaced this.
 *
 *  It also carries the owner's controls for WHICH shared AI is active and for
 *  turning sharing off. Those briefly had no home at all: they used to live on
 *  the /configuration hub and were dropped in the sections revamp, leaving a
 *  workspace with two approved AIs no way to switch between them. They belong
 *  here, with the rest of the AI setup, rather than on a hub. */
/** Everything that can power AI in this workspace, in ONE list: keys the
 *  workspace owns AND personal connections routed in. Each row says where it
 *  came from and whether it is the one currently serving calls.
 *
 *  Keeping them apart made the reader assemble the picture themselves, and the
 *  split is what let this page announce "No AI providers configured" while a
 *  shared connection was answering every call. */
function ConnectionsSection({
  slug,
  providers,
  defByPid,
  onAdd,
  onEdit,
}: {
  slug: string;
  providers: AiProvider[];
  defByPid: Map<string, AiProviderDef>;
  onAdd: () => void;
  onEdit: (p: AiProvider) => void;
}) {
  const shares = useQuery({
    queryKey: ["ai-shares", slug],
    queryFn: () => api.listAiShares(slug),
    enabled: !!slug,
  });
  const shared = shares.data?.items ?? [];
  const empty = providers.length === 0 && shared.length === 0;
  const aiStatus = useAiStatus();
  const planProvided = empty && aiStatus?.available && aiStatus.source === "managed";

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
            Connections
          </h2>
          <p className="text-xs text-faint mt-0.5">
            Everything that can answer an AI call here, whether this workspace
            owns it or someone shared it in.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white shrink-0"
        >
          <Plus className="h-4 w-4" /> Add provider
        </button>
      </div>

      {empty ? (
        <p className="text-sm text-faint">
          {planProvided ? (
            <>
              AI here is provided by your Cobblr plan - nothing to connect. Add a key this workspace owns to use a
              specific provider or track spend, or set up a personal connection at{" "}
              <Link to="/me/connections" className="text-accent hover:underline">
                your account
              </Link>{" "}
              and route it here.
            </>
          ) : (
            <>
              Nothing connected yet. Add a key this workspace owns, or set up a personal connection at{" "}
              <Link to="/me/connections" className="text-accent hover:underline">
                your account
              </Link>{" "}
              and route it here.
            </>
          )}
        </p>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              def={defByPid.get(p.provider_id) ?? null}
              onEdit={() => onEdit(p)}
            />
          ))}
          <SharedAiRows slug={slug} items={shared} />
        </div>
      )}
    </section>
  );
}

/** The shared-personal-connection rows of the Connections list, plus the
 *  owner's controls for which one is active. */
function SharedAiRows({ slug, items }: { slug: string; items: WorkspaceAiOffer[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { activeOrg } = useActiveOrg();
  const isOwner = activeOrg?.role === "owner";

  const approved = items.filter((i) => i.status === "approved");
  const pending = items.filter((i) => i.status === "pending");

  const onItems = (r: { items: WorkspaceAiOffer[] }) => {
    qc.setQueryData(["ai-shares", slug], r);
    void qc.invalidateQueries({ queryKey: ["ai-status"] });
  };
  const activate = useMutation({
    mutationFn: (cid: string | null) => api.setActiveAiShare(slug, cid),
    onSuccess: onItems,
    onError: (e) => toast.error((e as Error).message),
  });
  const approve = useMutation({
    mutationFn: (cid: string) => api.approveAiShare(slug, cid),
    onSuccess: (r) => {
      onItems(r);
      toast.success("Approved - this AI now powers the workspace.");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: (cid: string) => api.rejectAiShare(slug, cid),
    onSuccess: (r) => {
      onItems(r);
      toast.success("Offer declined.");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (items.length === 0) return null;

  return (
    <>
      {pending.length > 0 && (
        <div className="space-y-2">
          {pending.map((o) => (
            <div
              key={o.credential_id}
              className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
            >
              <div className="flex-1 min-w-0 text-sm">
                <span className="text-content dark:text-mortar-100">
                  {o.offered_by_name}
                </span>
                <span className="text-faint"> wants to share their AI here</span>
              </div>
              {isOwner ? (
                <>
                  <button
                    type="button"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(o.credential_id)}
                    className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={reject.isPending}
                    onClick={() => reject.mutate(o.credential_id)}
                    className="shrink-0 rounded border border-line dark:border-slate-600 text-muted hover:text-ember-500 text-xs font-medium px-2.5 py-1"
                  >
                    Decline
                  </button>
                </>
              ) : (
                <span className="text-xs text-faint shrink-0">waiting for the owner</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Same card shape as a workspace-owned provider row, so the list reads
          as one list. The only difference is the source line and, when there is
          more than one to choose from, the radio. */}
      {approved.map((o) => (
        <label
          key={o.credential_id}
          className={
            "flex items-center gap-2.5 rounded-lg border border-line dark:border-slate-700 px-3 py-2.5 " +
            (isOwner && approved.length > 1 ? "cursor-pointer" : "")
          }
        >
          {isOwner && approved.length > 1 && (
            <input
              type="radio"
              name={`active-ai-${slug}`}
              checked={o.active}
              onChange={() => activate.mutate(o.credential_id)}
              className="accent-cobble-600 shrink-0"
              aria-label={`Use ${o.is_own ? o.label || o.provider_id : `${o.offered_by_name}'s AI`} for this workspace`}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm text-content dark:text-mortar-100 truncate">
              {o.is_own ? o.label || o.provider_id : `${o.offered_by_name}'s AI`}
            </div>
            <div className="text-[11px] text-faint truncate">
              {o.provider_id} ·{" "}
              {o.is_own ? "your personal connection" : `shared by ${o.offered_by_name}`}
            </div>
          </div>
          {o.active ? (
            <span className="shrink-0 inline-flex items-center gap-1.5 text-xs text-moss-600 dark:text-moss-300">
              <span className="w-1.5 h-1.5 rounded-full bg-moss-500" />
              in use
            </span>
          ) : (
            <span className="shrink-0 text-xs text-faint">standing by</span>
          )}
        </label>
      ))}

      {isOwner && approved.some((o) => o.active) && (
        <button
          type="button"
          onClick={() => activate.mutate(null)}
          className="text-[11px] text-faint hover:text-ember-500"
        >
          Stop using shared connections in this workspace
        </button>
      )}
    </>
  );
}

// ── AI activity — your own AI calls (prompts + responses); owners/admins can
// toggle to the whole workspace. Full text in the detail modal. ──
function AiActivitySection({ slug }: { slug: string }) {
  const [scope, setScope] = useState<"mine" | "workspace">("mine");
  const [detail, setDetail] = useState<AiActivityItem | null>(null);
  const q = useQuery({
    queryKey: ["ai-activity", slug, scope],
    queryFn: () => api.aiActivity(slug, scope, 100),
    enabled: !!slug,
  });
  const items = q.data?.items ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">AI activity</h2>
        <div className="flex rounded-md border border-line dark:border-slate-700 overflow-hidden text-xs">
          {(["mine", "workspace"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={"px-3 py-1 transition " + (scope === s ? "bg-cobble-600 text-white" : "text-muted hover:text-accent")}
            >
              {s === "mine" ? "My calls" : "Whole workspace"}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-faint dark:text-slate-500">
        Every AI call you made - the chat, Build, scan, summaries - with the full prompt + response. {scope === "workspace" ? "Showing everyone's (owner/admin)." : "Showing yours."}
      </p>
      <div className={"rounded-xl border border-line dark:border-slate-700 overflow-hidden " + FEED_SCROLL_INNER}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 text-left">
              {["When", "Capability", "Model", "Tokens", "Source", ""].map((h) => (
                <th key={h} className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-b border-line dark:border-slate-800 last:border-0 hover:bg-subtle/40 dark:hover:bg-slate-800/30 cursor-pointer" onClick={() => setDetail(c)}>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{new Date(c.invoked_at).toLocaleString()}</td>
                <td className="px-3 py-1.5"><span className="font-mono text-[11px]">{c.capability}</span></td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{c.model ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{(c.input_tokens ?? 0) + (c.output_tokens ?? 0) || "—"}</td>
                <td className="px-3 py-1.5 text-faint whitespace-nowrap">{c.cached ? "cache" : c.source_kind ?? "—"}{c.ok ? "" : " ⚠"}</td>
                <td className="px-3 py-1.5 text-right text-accent">view</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-faint italic">{q.isLoading ? "Loading…" : "No AI calls yet."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {detail && <AiActivityDetail slug={slug} item={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function AiActivityDetail({ slug, item, onClose }: { slug: string; item: AiActivityItem; onClose: () => void }) {
  const q = useQuery({ queryKey: ["ai-activity-detail", slug, item.id], queryFn: () => api.aiActivityDetail(slug, item.id) });
  const d = q.data;
  const usage = usageLine(item);
  return (
    <Modal open onClose={onClose} title={`AI call · ${item.capability}`} size="lg">
      <div className="space-y-3 text-sm">
        <div className="text-xs text-muted" title={usage.title}>
          {item.model ?? "—"} · {new Date(item.invoked_at).toLocaleString()} · {usage.text}
        </div>
        {!d ? (
          <div className="text-faint text-xs">Loading full text…</div>
        ) : (
          <>
            <PayloadView label="Prompt" raw={d.input_full} emptyText="(purged or none)" />
            <PayloadView
              label="Response"
              raw={d.output_full ?? (d.error ? `Error: ${d.error}` : null)}
              emptyText="(purged or none)"
            />
          </>
        )}
      </div>
    </Modal>
  );
}

/** Live workspace-bridge status under the bridge-transit choice: is there a
 *  bridge connected for this workspace right now? Links to the pane of glass. */
function WorkspaceBridgeHint() {
  const { activeSlug } = useActiveOrg();
  const status = useQuery({
    queryKey: ["edge-status", activeSlug],
    queryFn: () => api.getEdgeStatus(activeSlug ?? ""),
    enabled: !!activeSlug,
    refetchInterval: 5000,
  });
  const agents = status.data?.agents ?? [];
  const stale = status.data?.stale_after_ms ?? 60_000;
  const live = agents.filter((a) => a.last_seen_ms < stale);
  const on = live.length > 0;
  return (
    <div className={"flex items-center gap-2 text-[11px] mt-1 rounded border p-1.5 " + (on ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 text-moss-700 dark:text-moss-300" : "border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400")}>
      <span className={"w-1.5 h-1.5 rounded-full shrink-0 " + (on ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
      <span className="flex-1">
        {on
          ? `${live.length === 1 ? "Your workspace bridge is" : `${live.length} workspace bridges are`} connected — calls route through it to your LAN.`
          : "No workspace bridge is connected — calls will fail until one dials in."}{" "}
        <Link to="/configuration/edge" className="underline">Edge bridges</Link>
      </span>
    </div>
  );
}

// ── Auto-pick photos ────────────────────────────────────────────────────────
// The workspace switch for AI-picking a scanned item's catalog photo on every
// enriched scan, rather than only when someone presses ✨ Pick best on the item.
//
// It also lives as a chip in the scan inbox header, which is where you are when
// you think about photos — but a chip in a busy toolbar is not where anyone
// LOOKS for "the global AI switch" (the author went hunting for it and had to ask). A
// setting that spends AI belongs on the AI page too, next to the connections
// that pay for it.
function AutoPickPhotosSection({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useQuery({
    queryKey: ["scan-photo-rank-config", slug],
    queryFn: () => api.getScanPhotoRankConfig(slug),
    enabled: !!slug && canEdit,
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setScanPhotoRankConfig(slug, enabled),
    onSuccess: (r) => {
      toast.success(
        r.enabled
          ? "Catalog photos will be AI-picked on every scan"
          : "Back to picking photos only when you press Pick best",
      );
      void qc.invalidateQueries({ queryKey: ["scan-photo-rank-config", slug] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save that"),
  });
  if (!canEdit) return null;
  const on = cfg.data?.enabled === true;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Scan photos</h2>
      <label className="mt-2 flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          disabled={save.isPending || cfg.isLoading}
          onChange={(e) => save.mutate(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-cobble-600 shrink-0"
        />
        <span className="min-w-0">
          <span className="text-sm text-content dark:text-mortar-100">
            Pick the catalog photo with AI on every scan
          </span>
          <span className="block text-xs text-faint dark:text-slate-400">
            Off by default. On, each newly identified item gets its photo chosen the same way the
            ✨ Pick best button does - the product alone, correct colour, no people - with no tapping.
            It uses AI on every scan rather than only when you ask, never replaces a photo you chose
            yourself, and never pays twice for the same item.
          </span>
          <span className="block text-xs text-faint dark:text-slate-400 mt-1">
            This is WHETHER Cobblr picks photos on its own. Which AI does the picking is the
            "Pick the best product photo" row under "What each job uses" below - that one is
            routing, and it applies to the ✨ Pick best button too.
          </span>
        </span>
      </label>
    </section>
  );
}

// The labels live in lib/ai-capability-labels.ts so a test can assert the
// contract's capabilities are all named. Re-exported for existing importers.
export { capabilityLabel } from "../lib/ai-capability-labels";
