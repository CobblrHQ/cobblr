// builds UI — the host mounts <BuildsUI /> at /builds. A grid of builds;
// clicking one opens a detail MODAL with its bill-of-materials, a live
// "can I build N right now / limiting component" readout, and a Build button
// that consumes the components from inventory stock. Modals (not pages) for
// detail/create; toasts for feedback; destructive deletes confirm. House style.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { Hammer, Plus, Trash2, X, Wrench, AlertTriangle, Layers, ListOrdered, Check, Circle, ChevronUp, ChevronDown, Clock, History, GitBranch, Search, CornerDownRight, CalendarClock } from "lucide-react";
import { BuildsApi, BuildsApiError, type BuildSummary, type PartOption, type OperationRow, type GenealogyNode } from "./api.js";

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
          No builds yet. A build is a recipe - a thing you assemble from tracked parts. Create one to see
          how many you can build right now.
        </div>
      )}

      {builds.data && builds.data.items.length > 0 && (
        <SchedulePanel api={api} builds={builds.data.items} />
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
  const [serial, setSerial] = useState("");
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
  const addSubAssembly = useMutation({
    mutationFn: (c: { sub_assembly_build_id: string; quantity: number }) => api.addSubAssembly(buildId, c),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const removeComponent = useMutation({
    mutationFn: (cid: string) => api.removeComponent(buildId, cid),
    onSuccess: invalidate,
  });
  const doBuild = useMutation({
    mutationFn: (v: { n: number; serial?: string }) => api.build(buildId, v.n, v.serial),
    onSuccess: (r) => {
      toast.success(`Built ${r.run.qty_built} — components consumed from stock`);
      setSerial("");
      void qc.invalidateQueries({ queryKey: ["builds-runs", buildId] });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const addOperation = useMutation({
    mutationFn: (name: string) => api.addOperation(buildId, { name }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const updateOperation = useMutation({
    mutationFn: (v: { opId: string; status?: OperationRow["status"]; seq?: number }) =>
      api.updateOperation(buildId, v.opId, { status: v.status, seq: v.seq }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const removeOperation = useMutation({
    mutationFn: (opId: string) => api.removeOperation(buildId, opId),
    onSuccess: invalidate,
  });
  const logTime = useMutation({
    mutationFn: (v: { opId: string; kind: "labor" | "machine" | "setup"; minutes: number }) =>
      api.logTime(buildId, v.opId, { kind: v.kind, minutes: v.minutes }),
    onSuccess: () => { toast.success("Time logged"); invalidate(); },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const logQuantity = useMutation({
    mutationFn: (v: { opId: string; kind: "good" | "scrap" | "rework"; quantity: number; reason?: string }) =>
      api.logQuantity(buildId, v.opId, { kind: v.kind, quantity: v.quantity, reason: v.reason }),
    onSuccess: (_d, v) => { toast.success(`${v.quantity} ${v.kind} logged`); invalidate(); },
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
                  type="text"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value)}
                  placeholder="serial / lot # (optional)"
                  className="w-36 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
                  aria-label="Output serial or lot number"
                  title="Tag this build's output with a serial/lot for traceability"
                />
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
                  onClick={() => doBuild.mutate({ n: qty, serial: serial.trim() || undefined })}
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
                  const isSub = c.kind === "subassembly";
                  const short = !isSub && (c.available ?? 0) < c.per_build;
                  return (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm group">
                      <span className="flex-1">
                        {isSub && <Layers size={12} className="inline-block mr-1.5 text-cobble-500 align-middle" />}
                        <span className="text-content dark:text-mortar-100">{c.name}</span>
                        {isSub && (
                          <span className="ml-2 inline-flex items-center rounded bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-medium text-cobble-700 dark:text-cobble-300 align-middle">
                            sub-assembly
                          </span>
                        )}
                        {c.optional && <span className="text-[10px] text-muted ml-1.5">(optional)</span>}
                        {!isSub && c.part_id && limitingIds.has(c.part_id) && (
                          <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 align-middle">
                            <AlertTriangle size={10} /> limiting
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted tabular-nums">
                        {isSub ? (
                          <>{c.per_build}/build · {c.sub_max_buildable ?? 0} buildable</>
                        ) : (
                          <>
                            {c.per_build}/build · <span className={short ? "text-red-500 font-medium" : ""}>{c.available} in stock</span>
                          </>
                        )}
                      </span>
                      <button type="button" onClick={() => removeComponent.mutate(c.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100" aria-label="Remove component">
                        <X size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <AddComponentRow
              api={api}
              currentBuildId={buildId}
              onAddPart={(part_id, quantity) => addComponent.mutate({ part_id, quantity })}
              onAddSub={(sub_assembly_build_id, quantity) => addSubAssembly.mutate({ sub_assembly_build_id, quantity })}
            />

            {/* Routing — the ordered steps to make this build */}
            <OperationsSection
              operations={d.operations}
              onAdd={(name) => addOperation.mutate(name)}
              onCycle={(op) => updateOperation.mutate({ opId: op.id, status: nextStatus(op.status) })}
              onMove={(op, dir) => {
                const sorted = [...d.operations].sort((a, b) => a.seq - b.seq);
                const i = sorted.findIndex((o) => o.id === op.id);
                const j = dir === "up" ? i - 1 : i + 1;
                if (j < 0 || j >= sorted.length) return;
                // Swap seq with the neighbour.
                updateOperation.mutate({ opId: op.id, seq: sorted[j]!.seq });
                updateOperation.mutate({ opId: sorted[j]!.id, seq: op.seq });
              }}
              onRemove={(opId) => removeOperation.mutate(opId)}
              onLogTime={(opId, kind, minutes) => logTime.mutate({ opId, kind, minutes })}
              onLogQty={(opId, kind, quantity, reason) => logQuantity.mutate({ opId, kind, quantity, reason })}
            />

            {/* Build history + as-built genealogy (rung 8) */}
            <HistorySection buildId={buildId} api={api} />
            <TraceBox api={api} />
          </>
        )}
      </div>
    </Modal>
  );
}

const STATUS_ORDER: OperationRow["status"][] = ["todo", "doing", "done"];
function nextStatus(s: OperationRow["status"]): OperationRow["status"] {
  if (s === "skipped") return "todo";
  const i = STATUS_ORDER.indexOf(s);
  return STATUS_ORDER[(i + 1) % STATUS_ORDER.length]!;
}

function OperationsSection({
  operations,
  onAdd,
  onCycle,
  onMove,
  onRemove,
  onLogTime,
  onLogQty,
}: {
  operations: OperationRow[];
  onAdd: (name: string) => void;
  onCycle: (op: OperationRow) => void;
  onMove: (op: OperationRow, dir: "up" | "down") => void;
  onRemove: (opId: string) => void;
  onLogTime: (opId: string, kind: "labor" | "machine" | "setup", minutes: number) => void;
  onLogQty: (opId: string, kind: "good" | "scrap" | "rework", quantity: number, reason?: string) => void;
}) {
  const [name, setName] = useState("");
  const [logging, setLogging] = useState<string | null>(null);
  const sorted = [...operations].sort((a, b) => a.seq - b.seq);

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted mb-1.5 flex items-center gap-1.5">
        <ListOrdered size={12} /> Routing
      </div>
      {sorted.length === 0 && (
        <div className="text-sm text-muted italic mb-2">No steps yet. Add the ordered operations to make this build.</div>
      )}
      {sorted.length > 0 && (
        <ol className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded mb-2">
          {sorted.map((op, i) => {
            const r = op.rollup;
            const hasExec = !!r && (r.actual_minutes > 0 || r.good_qty > 0 || r.scrap_qty > 0 || r.rework_qty > 0);
            return (
            <li key={op.id} className="text-sm group">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => onCycle(op)}
                  className="shrink-0"
                  title={`Status: ${op.status} — click to advance`}
                  aria-label={`Step status ${op.status}`}
                >
                  {op.status === "done" ? (
                    <Check size={16} className="text-green-600" />
                  ) : op.status === "doing" ? (
                    <Circle size={16} className="text-amber-500 fill-amber-500/30" />
                  ) : (
                    <Circle size={16} className="text-slate-300" />
                  )}
                </button>
                <span className="text-xs text-muted tabular-nums w-5">{i + 1}.</span>
                <span className={`flex-1 ${op.status === "done" ? "line-through text-muted" : "text-content dark:text-mortar-100"}`}>
                  {op.name}
                  {op.est_minutes != null && <span className="text-[10px] text-muted ml-1.5">est ~{op.est_minutes}m</span>}
                  {op.status === "skipped" && <span className="text-[10px] text-muted ml-1.5">(skipped)</span>}
                  {hasExec && (
                    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                      {r!.actual_minutes > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-subtle dark:bg-slate-800 px-1.5 py-0.5 text-[10px] text-muted"><Clock size={9} />{r!.actual_minutes}m</span>
                      )}
                      {r!.good_qty > 0 && <span className="rounded bg-green-50 dark:bg-green-900/30 px-1.5 py-0.5 text-[10px] text-green-700 dark:text-green-300">{r!.good_qty} good</span>}
                      {r!.scrap_qty > 0 && <span className="rounded bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] text-red-700 dark:text-red-300">{r!.scrap_qty} scrap</span>}
                      {r!.rework_qty > 0 && <span className="rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">{r!.rework_qty} rework</span>}
                      {r!.yield_pct != null && r!.scrap_qty > 0 && <span className="text-[10px] text-muted">· {r!.yield_pct}% yield</span>}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setLogging(logging === op.id ? null : op.id)}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${logging === op.id ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800 opacity-0 group-hover:opacity-100"}`}
                >
                  Log
                </button>
                <div className="flex items-center opacity-0 group-hover:opacity-100">
                  <button type="button" onClick={() => onMove(op, "up")} disabled={i === 0} className="text-slate-300 hover:text-content disabled:opacity-30" aria-label="Move up">
                    <ChevronUp size={14} />
                  </button>
                  <button type="button" onClick={() => onMove(op, "down")} disabled={i === sorted.length - 1} className="text-slate-300 hover:text-content disabled:opacity-30" aria-label="Move down">
                    <ChevronDown size={14} />
                  </button>
                  <button type="button" onClick={() => onRemove(op.id)} className="text-slate-300 hover:text-red-500 ml-1" aria-label="Remove step">
                    <X size={14} />
                  </button>
                </div>
              </div>
              {logging === op.id && (
                <OpLogRow
                  onTime={(kind, minutes) => onLogTime(op.id, kind, minutes)}
                  onQty={(kind, quantity, reason) => onLogQty(op.id, kind, quantity, reason)}
                />
              )}
            </li>
            );
          })}
        </ol>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            onAdd(name.trim());
            setName("");
          }
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add a step (e.g. Reflow paste)…"
          className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim()} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">
          Add step
        </button>
      </form>
    </div>
  );
}

function AddComponentRow({
  api,
  currentBuildId,
  onAddPart,
  onAddSub,
}: {
  api: BuildsApi;
  currentBuildId: string;
  onAddPart: (partId: string, qty: number) => void;
  onAddSub: (subBuildId: string, qty: number) => void;
}) {
  const [mode, setMode] = useState<"part" | "sub">("part");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<PartOption | null>(null);
  const [qty, setQty] = useState(1);
  const results = useQuery({
    queryKey: ["builds-component-search", mode, q],
    queryFn: () => (mode === "part" ? api.searchParts(q) : api.searchBuilds(q)),
    enabled: q.length > 0 && !picked,
  });
  // A build can't be its own sub-assembly — hide it from the picker.
  const options = (results.data ?? []).filter((o) => mode === "part" || o.id !== currentBuildId);

  const reset = (m?: "part" | "sub") => {
    setPicked(null);
    setQ("");
    setQty(1);
    if (m) setMode(m);
  };

  return (
    <div className="rounded-lg border border-dashed border-line dark:border-slate-700 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted">Add a component</div>
        <div className="inline-flex rounded border border-line dark:border-slate-700 overflow-hidden text-[11px]">
          <button type="button" onClick={() => reset("part")} className={`px-2 py-0.5 ${mode === "part" ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800"}`}>Part</button>
          <button type="button" onClick={() => reset("sub")} className={`px-2 py-0.5 ${mode === "sub" ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800"}`}>Sub-assembly</button>
        </div>
      </div>
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
          <button
            type="button"
            onClick={() => {
              if (mode === "part") onAddPart(picked.id, qty);
              else onAddSub(picked.id, qty);
              reset();
            }}
            className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white"
          >
            Add
          </button>
          <button type="button" onClick={() => reset()} className="px-2 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === "part" ? "Search inventory parts…" : "Search builds to nest as a sub-assembly…"}
            className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
          />
          {q.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg max-h-56 overflow-auto">
              {results.isLoading && <div className="px-3 py-2 text-xs text-muted">Searching…</div>}
              {!results.isLoading && options.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted italic">
                  {mode === "part"
                    ? "No parts. Components come from your inventory — enable Inventory and add parts first."
                    : "No other builds to nest. Create another build first."}
                </div>
              )}
              {options.map((p) => (
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

function OpLogRow({
  onTime,
  onQty,
}: {
  onTime: (kind: "labor" | "machine" | "setup", minutes: number) => void;
  onQty: (kind: "good" | "scrap" | "rework", quantity: number, reason?: string) => void;
}) {
  const [timeKind, setTimeKind] = useState<"labor" | "machine" | "setup">("labor");
  const [minutes, setMinutes] = useState("");
  const [qtyKind, setQtyKind] = useState<"good" | "scrap" | "rework">("good");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");

  const selCls = "rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-xs";
  const inCls = "w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs";

  return (
    <div className="px-3 pb-2.5 pt-0.5 bg-subtle/50 dark:bg-slate-800/30 space-y-2">
      {/* Log time */}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const m = Number(minutes);
          if (m > 0) { onTime(timeKind, m); setMinutes(""); }
        }}
      >
        <Clock size={12} className="text-muted" />
        <select value={timeKind} onChange={(e) => setTimeKind(e.target.value as typeof timeKind)} className={selCls}>
          <option value="labor">labor</option>
          <option value="machine">machine</option>
          <option value="setup">setup</option>
        </select>
        <input type="number" min={0} step="any" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="min" className={inCls} aria-label="Minutes" />
        <button type="submit" disabled={!(Number(minutes) > 0)} className="px-2 py-1 text-[11px] rounded bg-cobble-600 text-white disabled:opacity-40">Log time</button>
      </form>
      {/* Log quantity */}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(qty);
          if (n > 0) { onQty(qtyKind, n, reason.trim() || undefined); setQty(""); setReason(""); }
        }}
      >
        <select value={qtyKind} onChange={(e) => setQtyKind(e.target.value as typeof qtyKind)} className={selCls}>
          <option value="good">good</option>
          <option value="scrap">scrap</option>
          <option value="rework">rework</option>
        </select>
        <input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" className={inCls} aria-label="Quantity" />
        {qtyKind !== "good" && (
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)" className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs" aria-label="Reason" />
        )}
        <button type="submit" disabled={!(Number(qty) > 0)} className="px-2 py-1 text-[11px] rounded bg-cobble-600 text-white disabled:opacity-40">Log qty</button>
      </form>
    </div>
  );
}

function HistorySection({ buildId, api }: { buildId: string; api: BuildsApi }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["builds-runs", buildId], queryFn: () => api.listRuns(buildId) });
  const items = runs.data?.items ?? [];

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted mb-1.5 flex items-center gap-1.5">
        <History size={12} /> Build history
      </div>
      {items.length === 0 && <div className="text-sm text-muted italic">No builds recorded yet.</div>}
      {items.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
          {items.map((r) => (
            <li key={r.id} className="text-sm">
              <button
                type="button"
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-subtle dark:hover:bg-slate-800/50"
              >
                <GitBranch size={13} className="text-cobble-500 shrink-0" />
                <span className="flex-1 text-content dark:text-mortar-100">
                  Built {Number(r.qty_built)}
                  {r.serial_code && <span className="ml-2 rounded bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-mono text-cobble-700 dark:text-cobble-300">{r.serial_code}</span>}
                </span>
                <span className="text-[11px] text-muted">{new Date(r.built_at).toLocaleString()}</span>
              </button>
              {openRun === r.id && <RunGenealogy runId={r.id} api={api} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunGenealogy({ runId, api }: { runId: string; api: BuildsApi }) {
  const g = useQuery({ queryKey: ["builds-genealogy", runId], queryFn: () => api.getGenealogy(runId) });
  if (g.isLoading) return <div className="px-3 py-2 text-xs text-muted">Loading as-built…</div>;
  if (!g.data) return null;
  return (
    <div className="px-3 pb-2.5 pt-0.5 bg-subtle/40 dark:bg-slate-800/30">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-1">As-built (what went in)</div>
      <GenealogyTree node={g.data.tree} depth={0} />
      {g.data.lineage.length > 0 && (
        <div className="mt-1.5 text-[10px] text-muted">Lineage: {g.data.lineage.map((c) => <span key={c} className="font-mono mr-1.5">{c}</span>)}</div>
      )}
    </div>
  );
}

function GenealogyTree({ node, depth }: { node: GenealogyNode; depth: number }) {
  return (
    <ul className="text-xs">
      {node.inputs.length === 0 && <li className="text-muted italic">no recorded inputs</li>}
      {node.inputs.map((inp, i) => (
        <li key={i} style={{ paddingLeft: depth * 12 }}>
          <span className="inline-flex items-center gap-1 text-content dark:text-mortar-100">
            <CornerDownRight size={11} className="text-slate-400" />
            <span className="tabular-nums text-muted">{inp.quantity}×</span>
            <span className="font-mono text-[11px]">{inp.lot_code ?? inp.part_id.slice(0, 8)}</span>
            {inp.lot_code && <span className="text-[10px] text-muted">lot</span>}
          </span>
          {inp.source && (
            <div className="ml-3 border-l border-slate-200 dark:border-slate-700 pl-1.5 mt-0.5">
              <span className="text-[10px] text-muted">↳ made by a build producing {inp.source.output?.serial_code ?? "—"}</span>
              <GenealogyTree node={inp.source} depth={0} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function TraceBox({ api }: { api: BuildsApi }) {
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");
  const res = useQuery({ queryKey: ["builds-trace", query], queryFn: () => api.trace(query), enabled: query.length > 0 });
  const r = res.data;

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted mb-1.5 flex items-center gap-1.5">
        <Search size={12} /> Trace a lot / serial
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); setQuery(code.trim()); }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="enter a serial / lot # to trace…"
          className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm font-mono"
        />
        <button type="submit" disabled={!code.trim()} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Trace</button>
      </form>
      {query && r && (
        <div className="mt-2 text-xs space-y-1.5">
          <div>
            <span className="text-muted">Produced by:</span>{" "}
            {r.produced.length === 0 ? <span className="text-muted italic"> - none</span> : r.produced.map((p) => <span key={p.run_id} className="mr-2">{p.build_name} ({Number(p.quantity)})</span>)}
          </div>
          <div>
            <span className="text-muted">Consumed by:</span>{" "}
            {r.consumed.length === 0 ? <span className="text-muted italic"> - none</span> : r.consumed.map((c) => <span key={c.run_id} className="mr-2">{c.build_name} ({Number(c.quantity)})</span>)}
          </div>
          {r.produced.length === 0 && r.consumed.length === 0 && <div className="text-muted italic">No runs reference “{query}”.</div>}
        </div>
      )}
    </div>
  );
}

function fmtMins(m: number): string {
  if (m <= 0) return "—";
  const h = Math.floor(m / 60);
  const min = Math.round(m % 60);
  return h > 0 ? `${h}h${min ? ` ${min}m` : ""}` : `${min}m`;
}
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function SchedulePanel({ api, builds }: { api: BuildsApi; builds: BuildSummary[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const sched = useQuery({ queryKey: ["builds-schedule"], queryFn: () => api.getSchedule() });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["builds-schedule"] });
  const onErr = (e: unknown) => toast.error(e instanceof BuildsApiError ? e.message : String(e));

  const addPlanned = useMutation({
    mutationFn: (b: { build_id: string; qty: number; due_date: string | null; resource_label: string | null }) => api.addPlanned(b),
    onSuccess: () => { toast.success("Added to schedule"); setAdding(false); invalidate(); },
    onError: onErr,
  });
  const completePlanned = useMutation({
    mutationFn: (pid: string) => api.updatePlanned(pid, { status: "done" }),
    onSuccess: invalidate,
    onError: onErr,
  });
  const removePlanned = useMutation({
    mutationFn: (pid: string) => api.removePlanned(pid),
    onSuccess: invalidate,
    onError: onErr,
  });

  const lanes = sched.data?.lanes ?? [];
  const totalItems = lanes.reduce((n, l) => n + l.items.length, 0);
  const totalLate = lanes.reduce((n, l) => n + l.late_count, 0);

  return (
    <div className="rounded-lg border border-line dark:border-slate-700">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line dark:border-slate-700">
        <button type="button" onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1.5 text-sm font-medium text-content dark:text-mortar-100">
          <CalendarClock size={15} className="text-cobble-500" /> Production schedule
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <span className="text-[11px] text-muted">EDD heuristic · not a capacity solver</span>
        {totalLate > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
            <AlertTriangle size={10} /> {totalLate} at risk
          </span>
        )}
        <div className="flex-1" />
        <button type="button" onClick={() => setAdding((a) => !a)} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-cobble-600 text-white">
          <Plus size={12} /> Plan a build
        </button>
      </div>

      {!collapsed && (
        <div className="p-3 space-y-3">
          {adding && <AddPlannedRow builds={builds} onAdd={(v) => addPlanned.mutate(v)} onCancel={() => setAdding(false)} />}
          {sched.isLoading && <div className="text-sm text-muted">Loading…</div>}
          {!sched.isLoading && totalItems === 0 && (
            <div className="text-sm text-muted italic">Nothing planned. Add est-minutes to a build's routing steps, then plan one here to see a projected timeline.</div>
          )}
          {lanes.map((lane) => (
            <div key={lane.resource_label}>
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted mb-1">
                <span>{lane.resource_label}</span>
                <span className="text-[10px] normal-case">· {fmtMins(lane.total_minutes)} queued{lane.late_count > 0 ? ` · ${lane.late_count} late` : ""}</span>
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                {lane.items.map((it, i) => (
                  <li key={it.id} className="flex items-center gap-2 px-3 py-1.5 text-sm group">
                    <span className="text-xs text-muted tabular-nums w-5">{i + 1}.</span>
                    <span className="flex-1 text-content dark:text-mortar-100">
                      {it.qty}× {it.build_name}
                      {it.due_date && <span className={`ml-2 text-[10px] ${it.late ? "text-red-600 font-medium" : "text-muted"}`}>due {it.due_date}</span>}
                    </span>
                    <span className="text-[11px] text-muted tabular-nums">
                      {it.est_minutes_total > 0 ? `${fmtMins(it.est_minutes_total)} · ` : ""}done {fmtWhen(it.projected_finish)}
                    </span>
                    {it.late && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                        <AlertTriangle size={10} /> late
                      </span>
                    )}
                    <div className="flex items-center opacity-0 group-hover:opacity-100">
                      <button type="button" onClick={() => completePlanned.mutate(it.id)} className="text-slate-300 hover:text-green-600" title="Mark done" aria-label="Mark done"><Check size={14} /></button>
                      <button type="button" onClick={() => removePlanned.mutate(it.id)} className="text-slate-300 hover:text-red-500 ml-1" title="Remove" aria-label="Remove"><X size={14} /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddPlannedRow({ builds, onAdd, onCancel }: { builds: BuildSummary[]; onAdd: (v: { build_id: string; qty: number; due_date: string | null; resource_label: string | null }) => void; onCancel: () => void }) {
  const [buildId, setBuildId] = useState(builds[0]?.id ?? "");
  const [qty, setQty] = useState(1);
  const [due, setDue] = useState("");
  const [lane, setLane] = useState("");
  const inCls = "rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs";

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded border border-dashed border-line dark:border-slate-700 p-2"
      onSubmit={(e) => { e.preventDefault(); if (buildId) onAdd({ build_id: buildId, qty, due_date: due || null, resource_label: lane.trim() || null }); }}
    >
      <select value={buildId} onChange={(e) => setBuildId(e.target.value)} className={`${inCls} flex-1 min-w-32`} aria-label="Build">
        {builds.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} className={`${inCls} w-14`} aria-label="Quantity" />
      <label className="text-[11px] text-muted">due <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${inCls} ml-1`} aria-label="Due date" /></label>
      <input value={lane} onChange={(e) => setLane(e.target.value)} placeholder="lane (e.g. Laser)" className={`${inCls} w-28`} aria-label="Lane" />
      <button type="submit" disabled={!buildId} className="px-2 py-1 text-[11px] rounded bg-cobble-600 text-white disabled:opacity-50">Add</button>
      <button type="button" onClick={onCancel} className="px-2 py-1 text-[11px] rounded bg-subtle dark:bg-slate-800">Cancel</button>
    </form>
  );
}

export default BuildsUI;
