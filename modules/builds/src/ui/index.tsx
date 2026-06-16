// builds UI — the host mounts <BuildsUI /> at /builds. A grid of builds;
// clicking one opens a detail MODAL with its bill-of-materials, a live
// "can I build N right now / limiting component" readout, and a Build button
// that consumes the components from inventory stock. Modals (not pages) for
// detail/create; toasts for feedback; destructive deletes confirm. House style.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { Hammer, Plus, Trash2, X, Wrench, AlertTriangle } from "lucide-react";
import { BuildsApi, BuildsApiError, type BuildSummary, type PartOption } from "./api.js";

export const navItems = [{ label: "Builds", path: "/builds", icon: Hammer }];

interface Props {
  orgSlug: string;
  getToken: () => string | null;
}

export function BuildsUI({ orgSlug, getToken }: Props) {
  usePageTitle("Builds");
  const api = new BuildsApi(orgSlug, getToken);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const builds = useQuery({ queryKey: ["builds", orgSlug], queryFn: () => api.listBuilds() });

  const createBuild = useMutation({
    mutationFn: (name: string) => api.createBuild({ name }),
    onSuccess: (b) => {
      toast.success("Build created");
      setCreating(false);
      setNewName("");
      void qc.invalidateQueries({ queryKey: ["builds", orgSlug] });
      setOpen(b.id); // jump straight into adding components
    },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });

  const deleteBuild = useMutation({
    mutationFn: (id: string) => api.deleteBuild(id),
    onSuccess: () => {
      toast.success("Build deleted");
      void qc.invalidateQueries({ queryKey: ["builds", orgSlug] });
    },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">builds</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700"
        >
          <Plus size={14} /> New build
        </button>
      </div>

      {builds.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {builds.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">
          No builds yet. A build is a recipe — a thing you assemble from tracked parts. Create one to see
          how many you can build right now.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {builds.data?.items.map((b) => (
          <BuildCard
            key={b.id}
            build={b}
            onOpen={() => setOpen(b.id)}
            onDelete={async () => {
              if (
                await confirm({
                  title: `Delete "${b.name}"?`,
                  message: "This removes the build and its component list. Stock is not affected.",
                  confirmLabel: "Delete",
                  destructive: true,
                })
              ) {
                deleteBuild.mutate(b.id);
              }
            }}
          />
        ))}
      </div>

      {creating && (
        <Modal open onClose={() => setCreating(false)} title="New build">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) createBuild.mutate(newName.trim());
            }}
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Sensor board v2"
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
              <button type="submit" disabled={!newName.trim() || createBuild.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Create</button>
            </div>
          </form>
        </Modal>
      )}

      {open && <BuildDetailModal buildId={open} api={api} onClose={() => setOpen(null)} />}
    </div>
  );
}

function BuildCard({ build, onOpen, onDelete }: { build: BuildSummary; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 hover:border-cobble-400 transition group">
      <div className="flex items-start justify-between">
        <button type="button" onClick={onOpen} className="text-left">
          <div className="font-medium text-content dark:text-mortar-100">{build.name}</div>
          {build.description && <div className="text-xs text-muted mt-0.5 line-clamp-2">{build.description}</div>}
        </button>
        <button type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition" aria-label="Delete build">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function BuildDetailModal({ buildId, api, onClose }: { buildId: string; api: BuildsApi; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qty, setQty] = useState(1);
  const detail = useQuery({ queryKey: ["builds-detail", buildId], queryFn: () => api.getBuild(buildId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["builds-detail", buildId] });
    void qc.invalidateQueries({ queryKey: ["builds"] });
  };

  const addComponent = useMutation({
    mutationFn: (c: { part_id: string; quantity: number }) => api.addComponent(buildId, c),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const removeComponent = useMutation({
    mutationFn: (cid: string) => api.removeComponent(buildId, cid),
    onSuccess: invalidate,
  });
  const doBuild = useMutation({
    mutationFn: (n: number) => api.build(buildId, n),
    onSuccess: (r) => {
      toast.success(`Built ${r.run.qty_built} — components consumed from stock`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });

  const d = detail.data;
  const max = d?.buildable.max_buildable ?? 0;
  const limitingIds = new Set((d?.buildable.limiting ?? []).map((l) => l.part_id));

  return (
    <Modal open onClose={onClose} title={d?.build.name ?? "Build"} size="lg">
      <div className="space-y-4">
        {detail.isLoading && <div className="text-sm text-muted">Loading…</div>}

        {d && (
          <>
            {/* Can-I-build readout */}
            <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-3 flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Buildable now</div>
                <div className="text-2xl font-extrabold text-content dark:text-mortar-100">{max}</div>
                {d.buildable.limiting.length > 0 && max >= 0 && d.components.length > 0 && (
                  <div className="text-xs text-muted mt-0.5">
                    Limited by {d.buildable.limiting.map((l) => l.name).join(", ")}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                  className="w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  disabled={d.components.length === 0 || doBuild.isPending}
                  onClick={() => doBuild.mutate(qty)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
                  title={qty > max ? "More than current stock supports — stock can go negative" : undefined}
                >
                  <Wrench size={15} /> Build
                </button>
              </div>
            </div>

            {/* Bill of materials */}
            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-1.5">Components</div>
              {d.components.length === 0 && <div className="text-sm text-muted italic">No components yet. Add the parts this build consumes.</div>}
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                {d.components.map((c) => {
                  const short = c.available < c.per_build;
                  return (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm group">
                      <span className="flex-1">
                        <span className="text-content dark:text-mortar-100">{c.name}</span>
                        {c.optional && <span className="text-[10px] text-muted ml-1.5">(optional)</span>}
                        {limitingIds.has(c.part_id) && (
                          <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 align-middle">
                            <AlertTriangle size={10} /> limiting
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted tabular-nums">
                        {c.per_build}/build · <span className={short ? "text-red-500 font-medium" : ""}>{c.available} in stock</span>
                      </span>
                      <button type="button" onClick={() => removeComponent.mutate(c.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100" aria-label="Remove component">
                        <X size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <AddComponentRow api={api} onAdd={(part_id, quantity) => addComponent.mutate({ part_id, quantity })} />
          </>
        )}
      </div>
    </Modal>
  );
}

function AddComponentRow({ api, onAdd }: { api: BuildsApi; onAdd: (partId: string, qty: number) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<PartOption | null>(null);
  const [qty, setQty] = useState(1);
  const parts = useQuery({
    queryKey: ["builds-part-search", q],
    queryFn: () => api.searchParts(q),
    enabled: q.length > 0 && !picked,
  });

  return (
    <div className="rounded-lg border border-dashed border-line dark:border-slate-700 p-3 space-y-2">
      <div className="text-xs uppercase tracking-wide text-muted">Add a component</div>
      {picked ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm text-content dark:text-mortar-100">{picked.title}</span>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
            aria-label="Quantity per build"
          />
          <span className="text-xs text-muted">per build</span>
          <button type="button" onClick={() => { onAdd(picked.id, qty); setPicked(null); setQ(""); setQty(1); }} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white">Add</button>
          <button type="button" onClick={() => { setPicked(null); setQ(""); }} className="px-2 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search inventory parts…"
            className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
          />
          {q.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg max-h-56 overflow-auto">
              {parts.isLoading && <div className="px-3 py-2 text-xs text-muted">Searching…</div>}
              {parts.data?.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted italic">No parts. Components come from your inventory — enable Inventory and add parts first.</div>
              )}
              {parts.data?.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setPicked(p); setQ(p.title); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-subtle dark:hover:bg-slate-800"
                >
                  {p.title}
                  {p.subtitle && <span className="text-xs text-muted ml-2">{p.subtitle}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BuildsUI;
