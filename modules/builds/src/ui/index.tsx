export { AssemblyStation } from "./AssemblyStation.js";
import { BoardRevisionCard } from "./BoardRevisions.js";
import type { BoardRevision } from "../api/board-revisions.js";
export { BuildsApi } from "./api.js";
export { BoardProjectPanel } from "./BoardRevisions.js";
import { fieldNeed, FieldPack, RecordFormModal, CollectionHeader, ContributedDetailPanels, CustomFieldsPanel, useRecordInPath, headerButton, useToast, useConfirm, usePageTitle, SearchInput, NumberField, QuantityField, editOf } from "@cobblr/platform-web";
// builds UI — the host mounts <BuildsUI /> at /builds. A grid of builds;
// clicking one opens a detail MODAL with its bill-of-materials, a live
// "can I build N right now / limiting component" readout, and a Build button
// that consumes the components from inventory stock. Modals (not pages) for
// detail/create; toasts for feedback; destructive deletes confirm. House style.

import { useId, useState } from "react";
import { Link, useMatch } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Hammer, Plus, Trash2, X, Wrench, AlertTriangle, Layers, ListOrdered, Check, Circle, ChevronUp, ChevronDown, Clock, History, GitBranch, Search, CornerDownRight, CalendarClock } from "lucide-react";
import { BuildsApi, BuildsApiError, type BuildSummary, type ComponentRow, type PartOption, type OperationRow, type GenealogyNode } from "./api.js";
import { PickToLight, SegmentedChoice, SubjectLink } from "@cobblr/platform-web";
import { shortageSentence } from "../shortage.js";
import { BoardInspection } from "./Inspection.js";
import { InspectionRegister } from "./InspectionRegister.js";
import { useRunAction, offerUndo } from "@cobblr/platform-web";
import { withArticle } from "@cobblr/platform-contract/plural";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { dayLabel } from "@cobblr/platform-contract/day";

export const navItems = [{ label: "Builds", path: "/builds", icon: Hammer }];

interface Props {
  orgSlug: string;
  getToken: () => string | null;
}

export function BuildsUI({ orgSlug, getToken }: Props) {
  const inspection = useMatch("/builds/inspections/:id");
  const register = useMatch("/builds/inspections");
  // PRESS-ARGS: the saved inspection supplies the label target; queuing has no other required inputs.
  const run = useRunAction();
  if (inspection?.params.id) {
    return <BoardInspection slug={orgSlug} id={inspection.params.id} api={new BuildsApi(orgSlug, getToken)} queueLabel={async (id) => {
      const outcome = await run({ actionId: "labels:print", entityKind: "builds:inspection", entityId: id });
      const result = normaliseActionResult(outcome.result, "labels:print");
      if (!outcome.ok || !result.ok) throw new Error(typeof result.error === "string" ? result.error : "The label could not be queued.");
    }} />;
  }
  if (register) return <InspectionRegister api={new BuildsApi(orgSlug, getToken)} slug={orgSlug} />;
  return <BuildsCollectionUI orgSlug={orgSlug} getToken={getToken} />;
}

function BuildsCollectionUI({ orgSlug, getToken }: Props) {
  usePageTitle("Builds");
  const api = new BuildsApi(orgSlug, getToken);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // A build's address (/builds/<id>) opens it.
  const [open, setOpen] = useRecordInPath("builds");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // What it makes follows the name until the person says otherwise.
  const [makes, setMakes] = useState<string | null>(null);
  const makesValue = makes ?? newName;

  const builds = useQuery({ queryKey: ["builds", orgSlug], queryFn: () => api.listBuilds() });

  const createBuild = useMutation({
    mutationFn: (v: { name: string; makes: string }) => api.createBuild({ name: v.name, ...(v.makes ? { output_part_name: v.makes } : {}) }),
    onSuccess: (b) => {
      toast.success("Build created");
      setCreating(false);
      setNewName("");
      setMakes(null);
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
      <CollectionHeader
        title="builds"
        kind="builds:build"
        nav={<Link to="/builds/inspections">Board inspections</Link>}
        actions={
          <button type="button" onClick={() => setCreating(true)} className={headerButton("primary")}>
            <Plus size={14} /> New build
          </button>
        }
      />

      {builds.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {builds.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">
          No builds yet. A build is a parts list - a thing you assemble from tracked parts. Create one to see
          how many you can build right now.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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

      {/* Under the builds, not over them: the schedule's answer comes on its
          own, and above the cards its "Loading…" line growing to a plan moved
          every build's button 40 to 106 px under a finger (#7788). */}
      {builds.data && builds.data.items.length > 0 && (
        <SchedulePanel api={api} builds={builds.data.items} />
      )}

      {creating && (
        <RecordFormModal open onClose={() => setCreating(false)} title="New build">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) createBuild.mutate({ name: newName.trim(), makes: makesValue.trim() });
            }}
          >
            <FieldPack maxCols={2} items={[
              {
                need: fieldNeed("newName", { control: "text", label: "Build name" }),
                node: (
                  <input
                    autoFocus
                    aria-label="Build name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Sensor board v2"
                    className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
                  />
                ),
              },
              {
                need: fieldNeed("makesValue", { control: "text", label: "Makes" }),
                node: (
                  <label className="block text-xs text-muted">
                    Makes (the part each build adds to stock)
                    <input
                      aria-label="Part it makes"
                      value={makesValue}
                      onChange={(e) => setMakes(e.target.value)}
                      placeholder="Leave empty if it adds nothing to stock"
                      className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
                    />
                    <span className="block mt-1">A record with this name in any collection is used; otherwise it is added to your inventory with none in stock.</span>
                  </label>
                ),
              },
            ]} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
              <button type="submit" disabled={!newName.trim() || createBuild.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Create</button>
            </div>
          </form>
        </RecordFormModal>
      )}

      {open && <BuildDetailModal orgSlug={orgSlug} buildId={open} api={api} onClose={() => setOpen(null)} />}
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
        <button title="Delete build" type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 hover-reveal transition" aria-label="Delete build">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

export function BuildDetailModal({ buildId, api, orgSlug, onClose }: { buildId: string; api: BuildsApi; orgSlug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qty, setQty] = useState(1);
  const [serial, setSerial] = useState("");
  // Planned for the quantity being built: stocked sub-assemblies cover the first few, the rest are made.
  const detail = useQuery({ queryKey: ["builds-detail", buildId, qty], queryFn: () => api.getBuild(buildId, qty), placeholderData: (prev) => prev });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["builds-detail", buildId] });
    void qc.invalidateQueries({ queryKey: ["builds"] });
  };

  // PRESS-ARGS: it runs the step an action handed back (every argument it needs) and the component removal (the one line the press names).
  const runBack = useRunAction();
  const takeBack = async (b: Parameters<typeof runBack>[0]) => {
    const outcome = await runBack(b, { undo: "is-undo" });
    void qc.invalidateQueries({ queryKey: ["builds-runs", buildId] });
    invalidate();
    return outcome;
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
  // Through the action, so a component removed by a mistaken tap can be put back with its quantity,
  // optional flag and fitting notes: the action hands back its own inverse (#7982).
  const removeComponent = useMutation({
    mutationFn: async (c: { id: string; name: string }) => {
      const outcome = await runBack({ actionId: "builds:remove-component", entityKind: "builds:build", entityId: buildId, args: { component: c.id } }, { undo: "shown-here" });
      const done = `${c.name} removed.`;
      if (!offerUndo(toast, takeBack, outcome, { entityKind: "builds:build", entityId: buildId }, done)) toast.success(done);
    },
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  // A part line used up by a print (filament it melts) or back to stock if the print is scrapped (#8758).
  const comeBackChoice = useMutation({
    mutationFn: async (v: { partId: string; recoverable: boolean }) => {
      const outcome = await runBack({ actionId: "builds:set-line-recoverable", args: { build: buildId, part: v.partId, recoverable: v.recoverable } });
      if (outcome && typeof outcome === "object" && "ok" in outcome && outcome.ok === false) throw new Error(String((outcome as { error?: unknown }).error ?? "Not saved."));
    },
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : e instanceof Error ? e.message : String(e)),
  });
  const stockChoice = useMutation({
    mutationFn: (v: { id: string; use_stock: boolean }) => api.setComponentUseStock(buildId, v.id, v.use_stock),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const doBuild = useMutation({
    mutationFn: (v: { n: number; serial?: string }) => api.build(buildId, v.n, v.serial),
    onSuccess: (r) => {
      const out = detail.data?.output;
      const done = out?.name
        ? `Built ${r.run.qty_built}: ${Number(r.run.qty_built) * (Number(detail.data?.build.output_qty) || 1)} added to ${out.name}, components taken from stock`
        : `Built ${r.run.qty_built}: components taken from stock, nothing added (this build makes no part)`;
      // A build pressed by mistake can be taken back from the message.
      if (!offerUndo(toast, takeBack, { undo: r.undo, result: null }, { entityKind: "builds:build", entityId: buildId }, done)) toast.success(done);
      setSerial("");
      void qc.invalidateQueries({ queryKey: ["builds-runs", buildId] });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const setField = useMutation({
    mutationFn: (metadata: Record<string, unknown>) => api.updateBuild(buildId, editOf(detail.data?.build, { metadata })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const setDetails = useMutation({
    mutationFn: (v: { name: string; description: string | null; notes: string | null }) => api.updateBuild(buildId, editOf(detail.data?.build, v)),
    onSuccess: () => { toast.success("Saved."); invalidate(); },
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const setOutput = useMutation({
    mutationFn: (name: string) => api.updateBuild(buildId, editOf({ output_part_name: detail.data?.output?.name ?? null }, { output_part_name: name })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const addOperation = useMutation({
    mutationFn: (v: { name: string; est_minutes: number | null }) => api.addOperation(buildId, v),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const updateOperation = useMutation({
    mutationFn: (v: { opId: string; status?: OperationRow["status"]; seq?: number; est_minutes?: number | null }) =>
      api.updateOperation(buildId, v.opId, { status: v.status, seq: v.seq, est_minutes: v.est_minutes }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
  });
  const removeOperation = useMutation({
    mutationFn: (opId: string) => api.removeOperation(buildId, opId),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof BuildsApiError ? e.message : String(e)),
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
  const short = d ? (d.plan_qty === qty && d.shortage !== undefined ? d.shortage : shortageSentence(d.buildable.components ?? [], qty)) : null;
  const limitingIds = new Set((d?.buildable.limiting ?? []).map((l) => l.part_id));

  return (
    <RecordFormModal open onClose={onClose} title={d?.build.name ?? "Build"}>
      <div className="space-y-4">
        {detail.isLoading && <div className="text-sm text-muted">Loading…</div>}

        {d && (
          <>
            <BuildDetails
              key={`${d.build.id}:${d.build.name}:${d.build.description ?? ""}:${d.build.notes ?? ""}`}
              build={d.build}
              pending={setDetails.isPending}
              onSave={(v) => setDetails.mutate(v)}
            />
            {d.build.metadata?.assembly
              ? <BoardRevisionCard slug={orgSlug} id={buildId} spec={d.build.metadata.assembly as BoardRevision} api={api} />
              : <>
            <OutputLine
              output={d.output ?? null}
              buildName={d.build.name}
              perBuild={Number(d.build.output_qty) || 1}
              pending={setOutput.isPending}
              onSet={(name) => setOutput.mutate(name)}
            />
            {/* Can-I-build readout */}
            <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Buildable now</div>
                <div className="text-2xl font-extrabold text-content dark:text-mortar-100">{max}</div>
                {d.buildable.limiting.length > 0 && max >= 0 && d.components.length > 0 && (
                  <div className="text-xs text-muted mt-0.5">
                    Limited by {d.buildable.limiting.map((l) => l.name).join(", ")}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value)}
                  placeholder="serial / lot # (optional)"
                  className="w-36 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
                  aria-label="Output serial or lot number"
                  title="Tag this build's output with a serial/lot for traceability"
                />
                <NumberField label="Quantity"
                  min={1}
                  integer
                  value={qty}
                  onChange={setQty}
                  className="w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  disabled={d.components.length === 0 || !!short || doBuild.isPending}
                  onClick={() => doBuild.mutate({ n: qty, serial: serial.trim() || undefined })}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
                  aria-describedby={short ? "build-short" : undefined}
                >
                  <Wrench size={15} /> Build
                </button>
              </div>
              {short && <p id="build-short" className="basis-full text-xs text-ember-600 dark:text-ember-400" data-testid="build-short">{short}</p>}
            </div>

            {/* Bill of materials */}
            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-1.5">Components</div>
              <PickToLight key={buildId} lines={d.components.flatMap(c => c.part_id ? [{ id: c.id, label: `${c.name} (${c.per_build * qty})`, ref: { kind: "inventory:part", id: c.part_id } }] : [])} />
              {d.components.length === 0 && <div className="text-sm text-muted italic">No components yet. Add the parts this build consumes.</div>}
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                {d.components.map((c) => (
                  <ComponentLine
                    key={c.id}
                    c={c}
                    limiting={!!c.part_id && limitingIds.has(c.part_id)}
                    choosing={stockChoice.isPending}
                    onStockChoice={(use_stock) => stockChoice.mutate({ id: c.id, use_stock })}
                    buildName={d.build.name}
                    onComeBackChoice={(recoverable) => c.part_id && comeBackChoice.mutate({ partId: c.part_id, recoverable })}
                    onRemove={() => removeComponent.mutate({ id: c.id, name: c.name })}
                  />
                ))}
              </ul>
            </div>

            <AddComponentRow
              api={api}
              currentBuildId={buildId}
              onAddPart={(part_id, quantity) => addComponent.mutate({ part_id, quantity })}
              onAddSub={(sub_assembly_build_id, quantity) => addSubAssembly.mutate({ sub_assembly_build_id, quantity })}
            />

            {/* Yield: every good and scrap counted for this build, from hand
                logs and judged prints alike, so it is one number. */}
            {d.quality && d.quality.good_qty + d.quality.scrap_qty > 0 && (
              <div className="text-sm text-content dark:text-mortar-100" data-testid="build-yield">
                Made <strong>{d.quality.good_qty} good</strong>
                {d.quality.scrap_qty > 0 && <> · {d.quality.scrap_qty} scrap</>}
                {d.quality.yield_pct != null && <span className="text-muted"> ({d.quality.yield_pct}% yield)</span>}
              </div>
            )}

            {/* Routing — the ordered steps to make this build */}
            <OperationsSection
              operations={d.operations}
              onAdd={(name, est_minutes) => addOperation.mutate({ name, est_minutes })}
              onEstimate={(opId, est_minutes) => updateOperation.mutate({ opId, est_minutes })}
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
              onLogTime={(opId, kind, minutes) => logTime.mutateAsync({ opId, kind, minutes })}
              onLogQty={(opId, kind, quantity, reason) => logQuantity.mutateAsync({ opId, kind, quantity, reason })}
            />

            {/* The build's own fields: whatever a bundle adds to a build
                ("Sells for"), editable here like any other record's. */}
            <CustomFieldsPanel
              entityKind="builds:build"
              entityId={buildId}
              values={d.build.metadata ?? {}}
              onCommit={(name, value) => setField.mutate({ [name]: value })}
            />

            {/* Build history + as-built genealogy (rung 8) */}
            <HistorySection buildId={buildId} api={api} />
            <TraceBox api={api} />
              </>}
          </>
        )}

        {/* Tags and discussion, contributed at every kind. A record you
            open is a record somebody may want to say something about. */}
        <ContributedDetailPanels
          target="builds:build"
          ctx={{ slug: orgSlug, entityId: buildId, entityTitle: d?.build.name ?? "Build" }}
        />
      </div>
    </RecordFormModal>
  );
}

const STATUS_ORDER: OperationRow["status"][] = ["todo", "doing", "done"];
/** What a Build press adds to stock, said before anything is consumed. A
 *  build that makes no part says so and offers the part named like it. */
/** The build's own words: its name, what it is, and its notes. Reading shows
 *  them; Edit opens the three fields, and Save writes only these. */
function BuildDetails({ build, pending, onSave }: { build: BuildSummary; pending: boolean; onSave: (v: { name: string; description: string | null; notes: string | null }) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(build.name);
  const [description, setDescription] = useState(build.description ?? "");
  const [notes, setNotes] = useState(build.notes ?? "");
  const field = "w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm";
  if (!editing) {
    return (
      <div data-testid="build-details" className="space-y-1 text-sm">
        {build.description && <p className="text-content dark:text-mortar-100">{build.description}</p>}
        {build.notes && <p className="text-muted whitespace-pre-wrap">{build.notes}</p>}
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setEditing(true)}>
          Edit name and notes
        </button>
      </div>
    );
  }
  return (
    <form
      data-testid="build-details"
      className="rounded-lg border border-line dark:border-slate-700 p-3 text-sm space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSave({ name: name.trim(), description: description.trim() || null, notes: notes.trim() || null });
        setEditing(false);
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-muted">Name</span>
        <input aria-label="Build name" value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-muted">Description</span>
        <input aria-label="Build description" value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-muted">Notes</span>
        <textarea aria-label="Build notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={field} />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={pending || !name.trim()} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Save</button>
        <button type="button" className="rounded border border-line dark:border-slate-600 px-3 py-1.5 text-sm" onClick={() => { setName(build.name); setDescription(build.description ?? ""); setNotes(build.notes ?? ""); setEditing(false); }}>Cancel</button>
      </div>
    </form>
  );
}

function OutputLine({
  output,
  buildName,
  perBuild,
  pending,
  onSet,
}: {
  output: { part_id: string; name: string | null; qty: number | null } | null;
  buildName: string;
  perBuild: number;
  pending: boolean;
  onSet: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(output?.name ?? buildName);
  if (output && !editing) {
    return (
      <div data-testid="build-output" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted">Makes</span>
        <span className="font-medium text-content dark:text-mortar-100">
          {perBuild > 1 ? `${perBuild} × ` : ""}
          {output.name ?? "a part that is no longer in inventory"}
        </span>
        {output.qty !== null && <span className="text-xs text-muted">{output.qty} in stock</span>}
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setEditing(true)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <form
      data-testid="build-output"
      className={"rounded-lg border p-3 text-sm space-y-2 " + (output ? "border-line dark:border-slate-700" : "border-ember-300 bg-ember-50 dark:bg-ember-900/20 dark:border-ember-800")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSet(name.trim());
        setEditing(false);
      }}
    >
      {!output && <div className="text-danger">Building this takes its components from stock and adds nothing: say which part it makes.</div>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Part this build makes"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-0 basis-40 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={pending || !name.trim()} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">
          {output ? "Save" : "It makes this"}
        </button>
        {output && (
          <button type="button" className="text-xs text-muted" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
      <div className="text-xs text-muted">A record with this name in any collection is used; otherwise it is added to your inventory with none in stock.</div>
    </form>
  );
}

function nextStatus(s: OperationRow["status"]): OperationRow["status"] {
  if (s === "skipped") return "todo";
  const i = STATUS_ORDER.indexOf(s);
  return STATUS_ORDER[(i + 1) % STATUS_ORDER.length]!;
}

export function OperationsSection({
  operations,
  onAdd,
  onEstimate,
  onCycle,
  onMove,
  onRemove,
  onLogTime,
  onLogQty,
}: {
  operations: OperationRow[];
  onAdd: (name: string, estMinutes: number | null) => void;
  /** Set a step's estimated minutes; null clears it. What the build's projected finish is made from. */
  onEstimate: (opId: string, estMinutes: number | null) => void;
  onCycle: (op: OperationRow) => void;
  onMove: (op: OperationRow, dir: "up" | "down") => void;
  onRemove: (opId: string) => void;
  onLogTime: (opId: string, kind: "labor" | "machine" | "setup", minutes: number) => Promise<unknown>;
  onLogQty: (opId: string, kind: "good" | "scrap" | "rework", quantity: number, reason?: string) => Promise<unknown>;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [estText, setEstText] = useState("");
  const [estimating, setEstimating] = useState<string | null>(null);
  const [estEdit, setEstEdit] = useState("");
  const [editEstimateInvalid, setEditEstimateInvalid] = useState(false);
  const [newEstimateInvalid, setNewEstimateInvalid] = useState(false);
  const editEstimateErrorId = useId();
  const newEstimateErrorId = useId();
  const estimateError = "Enter zero or a positive number of minutes.";
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
                  title={`Step status: ${op.status} (click to advance)`}
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
                <span className={`flex-1 min-w-0 [overflow-wrap:anywhere] ${op.status === "done" ? "line-through text-muted" : "text-content dark:text-mortar-100"}`}>
                  {op.name}
                  <button
                    type="button"
                    onClick={() => { setEditEstimateInvalid(false); setEstimating(estimating === op.id ? null : op.id); setEstEdit(op.est_minutes != null ? String(Number(op.est_minutes)) : ""); }}
                    className="text-[10px] text-muted hover:text-content hover:underline ml-1.5"
                    aria-label={op.est_minutes != null ? `Estimate for ${op.name}: ${Number(op.est_minutes)} minutes. Change` : `Set the estimated minutes for ${op.name}`}
                  >
                    {op.est_minutes != null ? `est ~${Number(op.est_minutes)}m` : "set estimate"}
                  </button>
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
                  className={`text-[10px] px-1.5 py-0.5 rounded ${logging === op.id ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800 hover-reveal"}`}
                >
                  Log
                </button>
                <div className="flex shrink-0 items-center hover-reveal">
                  <button title="Move up" type="button" onClick={() => onMove(op, "up")} disabled={i === 0} className="text-slate-300 hover:text-content disabled:opacity-30" aria-label="Move up">
                    <ChevronUp size={14} />
                  </button>
                  <button title="Move down" type="button" onClick={() => onMove(op, "down")} disabled={i === sorted.length - 1} className="text-slate-300 hover:text-content disabled:opacity-30" aria-label="Move down">
                    <ChevronDown size={14} />
                  </button>
                  <button title="Remove step" type="button" onClick={async () => {
                    if (await confirm({
                      title: `Remove "${op.name}"?`,
                      message: "This permanently deletes the step, its estimate, all logged time, and its good, scrap and rework counts. This cannot be undone.",
                      confirmLabel: "Remove step",
                      destructive: true,
                    })) onRemove(op.id);
                  }} className="text-slate-300 hover:text-red-500 ml-1" aria-label="Remove step">
                    <X size={14} />
                  </button>
                </div>
              </div>
              {op.description && (
                <div data-testid="step-instructions" className="px-3 pb-2 pl-14 text-xs text-muted whitespace-pre-wrap">{op.description}</div>
              )}
              {estimating === op.id && (
                <form
                  className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = estEdit.trim() === "" ? null : Number(estEdit);
                    if (n !== null && (!Number.isFinite(n) || n < 0)) {
                      setEditEstimateInvalid(true);
                      return;
                    }
                    onEstimate(op.id, n);
                    setEstimating(null);
                  }}
                >
                  <input
                    inputMode="decimal"
                    value={estEdit}
                    onChange={(e) => { setEstEdit(e.target.value); setEditEstimateInvalid(false); }}
                    aria-invalid={editEstimateInvalid || undefined}
                    aria-describedby={editEstimateInvalid ? editEstimateErrorId : undefined}
                    aria-label={`Estimated minutes for ${op.name}`}
                    placeholder="minutes"
                    className="w-24 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm"
                  />
                  <button type="submit" className="px-2 py-1 rounded bg-cobble-600 text-white">Save estimate</button>
                  <button type="button" className="px-2 py-1 text-muted hover:text-content" onClick={() => setEstimating(null)}>Cancel</button>
                  {editEstimateInvalid && <p id={editEstimateErrorId} role="alert" className="basis-full text-xs text-ember-700 dark:text-ember-300">{estimateError}</p>}
                </form>
              )}
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
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            const est = estText.trim() === "" ? null : Number(estText);
            if (est !== null && (!Number.isFinite(est) || est < 0)) {
              setNewEstimateInvalid(true);
              return;
            }
            onAdd(name.trim(), est);
            setName("");
            setEstText("");
          }
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add a step (e.g. Reflow paste)…"
          className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        <input
          inputMode="decimal"
          value={estText}
          onChange={(e) => { setEstText(e.target.value); setNewEstimateInvalid(false); }}
          aria-invalid={newEstimateInvalid || undefined}
          aria-describedby={newEstimateInvalid ? newEstimateErrorId : undefined}
          aria-label="Estimated minutes for this step"
          placeholder="est min"
          className="w-20 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim()} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">
          Add step
        </button>
        {newEstimateInvalid && <p id={newEstimateErrorId} role="alert" className="basis-full text-xs text-ember-700 dark:text-ember-300">{estimateError}</p>}
      </form>
    </div>
  );
}

export function AddComponentRow({
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
          <QuantityField
            unit={mode === "part" ? picked.unit : null}
            value={qty}
            onChange={setQty}
            className="w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
            label="Quantity per build"
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
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder={mode === "part" ? "Search your stock…" : "Search builds to nest as a sub-assembly…"}
            aria-label={mode === "part" ? "Search your stock" : "Search builds"}
          />
          {q.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg max-h-56 overflow-auto">
              {results.isLoading && <div className="px-3 py-2 text-xs text-muted">Searching…</div>}
              {!results.isLoading && options.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted italic">
                  {mode === "part"
                    ? "Nothing kept in stock matches. Components come from any collection you keep stock in."
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
                  {p.collection && <span className="text-xs text-muted ml-2">in {p.collection}</span>}
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
  onTime: (kind: "labor" | "machine" | "setup", minutes: number) => Promise<unknown>;
  onQty: (kind: "good" | "scrap" | "rework", quantity: number, reason?: string) => Promise<unknown>;
}) {
  const [timeKind, setTimeKind] = useState<"labor" | "machine" | "setup">("labor");
  const [minutes, setMinutes] = useState("");
  const [qtyKind, setQtyKind] = useState<"good" | "scrap" | "rework">("good");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [savingTime, setSavingTime] = useState(false);
  const [savingQty, setSavingQty] = useState(false);

  const selCls = "rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-1 text-xs";
  const inCls = "w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs";

  return (
    <div className="px-3 pb-2.5 pt-0.5 bg-subtle/50 dark:bg-slate-800/30 space-y-2">
      {/* Log time */}
      <form
        className="flex items-center gap-1.5"
        onSubmit={async (e) => {
          e.preventDefault();
          const m = Number(minutes);
          if (savingTime || !(m > 0)) return;
          setSavingTime(true);
          try {
            await onTime(timeKind, m);
            setMinutes("");
          } catch {
            // quiet: the mutation shows the failure; keep the entry for another try.
          } finally {
            setSavingTime(false);
          }
        }}
      >
        <Clock size={12} className="text-muted" />
        <select aria-label="Time kind" disabled={savingTime} value={timeKind} onChange={(e) => setTimeKind(e.target.value as typeof timeKind)} className={selCls}>
          <option value="labor">labor</option>
          <option value="machine">machine</option>
          <option value="setup">setup</option>
        </select>
        <input type="number" min={0} step="any" value={minutes} disabled={savingTime} onChange={(e) => setMinutes(e.target.value)} placeholder="min" className={inCls} aria-label="Minutes" />
        <button type="submit" disabled={savingTime || !(Number(minutes) > 0)} className="px-2 py-1 text-[11px] rounded bg-cobble-600 text-white disabled:opacity-40">Log time</button>
      </form>
      {/* Log quantity */}
      <form
        className="flex items-center gap-1.5"
        onSubmit={async (e) => {
          e.preventDefault();
          const n = Number(qty);
          if (savingQty || !(n > 0)) return;
          setSavingQty(true);
          try {
            await onQty(qtyKind, n, reason.trim() || undefined);
            setQty("");
            setReason("");
          } catch {
            // quiet: the mutation shows the failure; keep the entry for another try.
          } finally {
            setSavingQty(false);
          }
        }}
      >
        <select aria-label="Quantity kind" disabled={savingQty} value={qtyKind} onChange={(e) => setQtyKind(e.target.value as typeof qtyKind)} className={selCls}>
          <option value="good">good</option>
          <option value="scrap">scrap</option>
          <option value="rework">rework</option>
        </select>
        <input type="number" min={0} step="any" value={qty} disabled={savingQty} onChange={(e) => setQty(e.target.value)} placeholder="qty" className={inCls} aria-label="Quantity" />
        {qtyKind !== "good" && (
          <input value={reason} disabled={savingQty} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)" className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs" aria-label="Reason" />
        )}
        <button type="submit" disabled={savingQty || !(Number(qty) > 0)} className="px-2 py-1 text-[11px] rounded bg-cobble-600 text-white disabled:opacity-40">Log qty</button>
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

export function RunGenealogy({ runId, api }: { runId: string; api: BuildsApi }) {
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
            {inp.subject
              ? <SubjectLink href={inp.subject.href} className="text-accent hover:underline">{inp.subject.title}</SubjectLink>
              : <span className="italic text-muted">a record you cannot open</span>}
            {inp.lot_code && <span className="text-[10px] text-muted">lot <span className="font-mono">{inp.lot_code}</span></span>}
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
  const ordinaryBuilds = builds.filter(b => !b.metadata?.assembly);

  return (
    <div className="rounded-lg border border-line dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line dark:border-slate-700">
        <button type="button" onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1.5 text-sm font-medium text-content dark:text-mortar-100">
          <CalendarClock size={15} className="text-cobble-500" /> Production schedule
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <span className="text-[11px] text-muted">Ordered by due date. Machine availability is not included.</span>
        <div className="flex-1" />
        {ordinaryBuilds.length > 0 && <button type="button" onClick={() => setAdding((a) => !a)} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-cobble-600 text-white">
          <Plus size={12} /> Plan a build
        </button>}
      </div>

      {!collapsed && (
        <div className="p-3 space-y-3">
          {adding && <AddPlannedRow builds={ordinaryBuilds} onAdd={(v) => addPlanned.mutate(v)} onCancel={() => setAdding(false)} />}
          {/* Under the header, not in it: arriving there it pushed Plan a build along (#7794). */}
          {totalLate > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
              <AlertTriangle size={10} /> {totalLate} at risk
            </span>
          )}
          {sched.isLoading && <div className="text-sm text-muted">Loading…</div>}
          {!sched.isLoading && totalItems === 0 && (
            <div className="text-sm text-muted italic">Nothing planned. Give a build's routing steps estimated minutes, then plan one here to see a projected timeline.</div>
          )}
          {lanes.map((lane) => (
            <div key={lane.resource_label}>
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted mb-1">
                <span>{lane.resource_label}</span>
                <span className="text-[10px] normal-case">· {fmtMins(lane.total_minutes)} queued{lane.late_count > 0 ? ` · ${lane.late_count} late` : ""}</span>
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
                {lane.items.map((it, i) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm group">
                    <span className="text-xs text-muted tabular-nums w-5">{i + 1}.</span>
                    <span className="flex-1 text-content dark:text-mortar-100">
                      {it.qty}× {it.build_name}
                      {(it.good_qty ?? 0) + (it.scrap_qty ?? 0) > 0 && (
                        <span className="ml-2 text-[11px] text-muted" data-testid="planned-made">
                          {it.good_qty ?? 0} of {it.qty} made{(it.scrap_qty ?? 0) > 0 ? ` · ${it.scrap_qty} scrap` : ""}
                        </span>
                      )}
                      {it.for_title && (
                        it.for_url ? (
                          <Link to={it.for_url} className="ml-2 text-[11px] text-accent hover:underline" data-testid="planned-for">for {it.for_title}</Link>
                        ) : (
                          <span className="ml-2 text-[11px] text-muted" data-testid="planned-for">for {it.for_title}</span>
                        )
                      )}
                      {it.due_date && <span className={`ml-2 text-[10px] ${it.late ? "text-red-600 font-medium" : "text-muted"}`}>due {dayLabel(it.due_date, { month: "short", day: "numeric" })}</span>}
                    </span>
                    <span className="text-[11px] text-muted tabular-nums">
                      {it.est_minutes_total > 0 ? `${fmtMins(it.est_minutes_total)} · Estimated finish ${fmtWhen(it.projected_finish)}` : "Finish time needs step estimates"}
                    </span>
                    {it.late && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-red-50 dark:bg-red-900/30 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                        <AlertTriangle size={10} /> late
                      </span>
                    )}
                    {it.assembly_state ? <Link className="text-accent underline text-xs" to={`/builds/${it.build_id}`}>Assembly kit · {it.assembly_state}</Link> : <div className="flex items-center hover-reveal">
                      <button type="button" onClick={() => completePlanned.mutate(it.id)} className="text-slate-300 hover:text-green-600" title="Mark done" aria-label="Mark done"><Check size={14} /></button>
                      <button type="button" onClick={() => removePlanned.mutate(it.id)} className="text-slate-300 hover:text-red-500 ml-1" title="Remove" aria-label="Remove"><X size={14} /></button>
                    </div>}
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
      <NumberField min={1} integer value={qty} onChange={setQty} className={`${inCls} w-14`} label="Quantity" />
      <label className="text-[11px] text-muted">due <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${inCls} ml-1`} aria-label="Due date" /></label>
      <input value={lane} onChange={(e) => setLane(e.target.value)} placeholder="lane (e.g. Laser)" className={`${inCls} w-28`} aria-label="Lane" />
      <button type="submit" disabled={!buildId} className="px-2 py-1 text-[11px] rounded bg-cobble-600 text-white disabled:opacity-50">Add</button>
      <button type="button" onClick={onCancel} className="px-2 py-1 text-[11px] rounded bg-subtle dark:bg-slate-800">Cancel</button>
    </form>
  );
}

export default BuildsUI;

export { ReflowStation } from "./ReflowStation.js";

export { InspectionStation } from "./InspectionStation.js";
export { BoardInspection } from "./Inspection.js";

/** One line of a build's bill of materials: what it is, how much each build
 *  takes and where it comes from, and its tools. */
export function ComponentLine({ c, limiting, choosing, onStockChoice, buildName, onComeBackChoice, onRemove }: {
  c: ComponentRow;
  limiting: boolean;
  choosing: boolean;
  onStockChoice: (useStock: boolean) => void;
  /** The build's name, for the scrapped-print choice's label. */
  buildName?: string;
  /** A part line: used up by a print (false) or back to stock when it is scrapped (true). */
  onComeBackChoice?: (recoverable: boolean) => void;
  onRemove: () => void;
}) {
  const isSub = c.kind === "subassembly";
  const short = !isSub && (c.available ?? 0) < c.per_build;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm group">
      <span className="flex-1 min-w-0 basis-40 [overflow-wrap:anywhere]">
        {isSub && <Layers size={12} className="inline-block mr-1.5 text-cobble-500 align-middle" />}
        <span className="text-content dark:text-mortar-100">{c.name}</span>
        {isSub && (
          <span className="ml-2 inline-flex items-center rounded bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-medium text-cobble-700 dark:text-cobble-300 align-middle">
            sub-assembly
          </span>
        )}
        {c.optional && <span className="text-[10px] text-muted ml-1.5">(optional)</span>}
        {c.notes && <span data-testid="component-notes" className="block text-xs text-muted whitespace-pre-wrap">{c.notes}</span>}
        {!isSub && limiting && (
          <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 align-middle">
            <AlertTriangle size={10} /> limiting
          </span>
        )}
      </span>
      <span className="text-xs text-muted tabular-nums min-w-0">
        {isSub ? (
          <>
            {c.per_build}/build · {c.sub_max_buildable ?? 0} buildable
            {c.from_stock != null && c.to_make != null && (c.from_stock > 0 || c.to_make > 0) && (
              <> · <span data-testid="sub-plan">{[c.from_stock > 0 ? `${c.from_stock} from stock` : null, c.to_make > 0 ? `${c.to_make} to make` : null].filter(Boolean).join(", ")}</span></>
            )}
          </>
        ) : (
          <>
            {c.per_build}/build · <span className={short ? "text-red-500 font-medium" : ""}>{c.available} in stock</span>
          </>
        )}
      </span>
      <span className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
      {/* Both ways are named, the one in force marked: a single button
          read as an order to "Use stock first" while it named the state
          it was already in, and pressing it threw the stock away (#8630). */}
      {isSub && (
        <SegmentedChoice
          label={`Where each ${c.name} comes from`}
          value={c.use_stock === false ? "make" : "stock"}
          onChange={(v) => onStockChoice(v === "stock")}
          disabled={choosing}
          options={[
            { value: "stock", label: "Stock first", testId: "sub-from-stock" },
            { value: "make", label: "Always make", testId: "sub-always-make" },
          ]}
        />
      )}
      {/* A print melts its filament whatever the verdict, so a line is used up
          unless it is marked to come back, like inserts never fitted (#8758). */}
      {!isSub && onComeBackChoice && (
        <SegmentedChoice
          label={`If ${withArticle(buildName ?? "build")} print is scrapped, ${c.name}`}
          value={c.recoverable ? "back" : "used"}
          onChange={(v) => onComeBackChoice(v === "back")}
          disabled={choosing}
          options={[
            { value: "used", label: "Used up", testId: "line-used-up" },
            { value: "back", label: "Back to stock", testId: "line-back-to-stock" },
          ]}
        />
      )}
      <button title="Remove component" type="button" onClick={onRemove} className="text-slate-300 hover:text-red-500 hover-reveal" aria-label="Remove component">
        <X size={14} />
      </button>
      </span>
    </li>
  );
}
