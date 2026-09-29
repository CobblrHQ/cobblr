// Project detail — header + inline tasks list. Tasks are added,
// checked off, deleted inline. Cross-module dependencies render as
// pill chips on the task row.

import { useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, Trash2 } from "lucide-react";
import { ContributedDetailPanels, EntityActionsBar, CustomFieldsPanel, MutationError, PresentationGate, useFieldDraft, usePageTitle, useUnits } from "@cobblr/platform-web";
import { useProjects } from "./context";
import { DesignFiles } from "./DesignFiles";
import { PatternNeedsPanel, patternNeedsKey } from "./PatternNeeds";
import { useFieldPresentation } from "./useFieldPresentation";
import type { InvPart, Priority, ProjectStatus, ProjectsApi, Task, TaskStatus } from "./api";
import { PART_PICKER_KEY, PartPicker } from "./PartPicker";

const PROJECT_STATUSES: ProjectStatus[] = ["planning", "active", "blocked", "done", "abandoned"];
const PRIORITIES: Priority[] = ["low", "med", "high", "urgent"];

// An input over one of the project's own values. It shows the record, holds
// a draft while typed in, and follows the record while untouched, so an
// action run from this page (a status change, a duplicate) shows here at once
// rather than after the page is reopened (useFieldDraft). Dates write on
// change (a mobile date picker does not reliably blur), text on blur.
function ProjectInput({
  value,
  commitOn,
  onCommit,
  ...rest
}: Omit<ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "onBlur"> & {
  value: string;
  commitOn: "blur" | "change";
  onCommit: (v: string) => void;
}) {
  const f = useFieldDraft(value);
  return (
    <input
      {...rest}
      value={f.draft}
      onChange={(e) => {
        f.setDraft(e.target.value);
        if (commitOn === "change") {
          f.committed(e.target.value);
          onCommit(e.target.value);
        }
      }}
      onBlur={(e) => {
        if (commitOn !== "blur" || e.target.value === value) return;
        f.committed(e.target.value);
        onCommit(e.target.value);
      }}
    />
  );
}

// A textarea that grows to fit its content so a long value (e.g. a full
// AI-generated pattern pasted into the description) is visible without
// scrolling a tiny fixed box. Keeps `resize-y` so the user can still shrink it.
function AutoGrowTextarea({
  minRows = 2,
  ...props
}: ComponentProps<"textarea"> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  // Size to the loaded value on mount and whenever the value prop changes.
  useLayoutEffect(grow, [props.value, props.defaultValue]);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      {...props}
      onInput={(e) => {
        grow();
        props.onInput?.(e);
      }}
    />
  );
}

/** The description, a draft over the record like ProjectInput. */
function DescriptionField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const f = useFieldDraft(value);
  return (
    <AutoGrowTextarea
      value={f.draft}
      onChange={(e) => f.setDraft(e.target.value)}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v === value) return;
        f.committed(v);
        onCommit(v);
      }}
      minRows={3}
      placeholder="What is this project about?"
      className="input text-sm w-full resize-y"
    />
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api, orgSlug, entityKind, instance, displayName } = useProjects();
  // Route "back" to the collection the user actually came from: a Designs (or
  // any named) instance lives at /instances/<name>, not the empty base
  // /projects. Mirrors ProjectsListPage's basePath.
  const backPath = instance ? `/instances/${instance}` : "/projects";
  const backLabel = displayName ? displayName.toLowerCase() : "projects";
  // Native-field presentation (relabel + show/hide via bundle/config); no-op
  // until an override exists. Keyed off the INSTANCE kind (designs:item) so a
  // Designs instance's custom fields (pattern link, category) actually resolve —
  // using projects:project fetched the base kind and showed NONE of them
  // (reported: no place to add a pattern link on a design).
  const fp = useFieldPresentation(entityKind);
  const qc = useQueryClient();

  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id!),
    enabled: !!id,
  });
  usePageTitle(project.data?.name ?? "Project");
  const tasks = useQuery({
    queryKey: ["project-tasks", id],
    queryFn: () => api.listTasks({ project_id: id }),
    enabled: !!id,
  });

  const updateProject = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updateProject(id!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", id] });
      void qc.invalidateQueries({ queryKey: ["projects-list"] });
    },
  });

  // Status drives what the pattern takes off the stash: finishing uses each
  // yarn up (its own balls first) and whatever else was reserved for it;
  // abandoning returns it all. The server does it on the status change itself
  // (settlePattern), so a status set from a table, a board or the assistant
  // settles the same way; this page only refreshes what it shows.
  async function handleStatusChange(newStatus: string) {
    await updateProject.mutateAsync({ status: newStatus });
    if (newStatus !== "done" && newStatus !== "abandoned") return;
    void qc.invalidateQueries({ queryKey: ["design-allocations", id] });
    void qc.invalidateQueries({ queryKey: patternNeedsKey(id!) });
    void qc.invalidateQueries({ queryKey: [PART_PICKER_KEY] });
  }

  if (project.isLoading) return <div className="text-sm text-faint dark:text-slate-500">loading…</div>;
  if (!project.data) return <div className="text-sm text-ember-500">Project not found.</div>;
  // The collection's presentation decides the fields; nothing generic is drawn
  // in its place while it loads or when it cannot be read.
  if (!fp.ready || fp.failed) {
    return (
      <PresentationGate ready={fp.ready} failed={fp.failed} retry={fp.retry}>
        {null}
      </PresentationGate>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <Link to={backPath} className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent">
        <ArrowLeft size={12} /> back to {backLabel}
      </Link>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-start gap-3">
          <ProjectInput
            value={project.data.name}
            commitOn="blur"
            onCommit={(v) => {
              if (v.trim() && v.trim() !== project.data!.name) updateProject.mutate({ name: v.trim() });
            }}
            className="font-display text-2xl font-bold text-content dark:text-mortar-100 bg-transparent flex-1 min-w-0 focus:outline-none focus:bg-subtle dark:focus:bg-slate-800/70 rounded px-1"
          />
          <SaveStatus
            saving={updateProject.isPending}
            saved={updateProject.isSuccess}
            failed={updateProject.isError}
            className="mt-2 shrink-0"
          />
          <EntityActionsBar
            entityKind="projects:project"
            entityId={project.data.id}
            entityLabel={project.data.name}
            className="mt-1"
          />
        </div>
        <div className="flex gap-4 items-center flex-wrap">
          {!fp.hidden("status") && (
            <Labelled label={fp.label("status", "status")}>
              <select
                value={project.data.status}
                onChange={(e) => void handleStatusChange(e.target.value)}
                className="input !w-auto !py-1 text-xs"
              >
                {PROJECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Labelled>
          )}
          {!fp.hidden("priority") && (
            <Labelled label={fp.label("priority", "priority")}>
              <select
                value={project.data.priority ?? "med"}
                onChange={(e) => updateProject.mutate({ priority: e.target.value })}
                className="input !w-auto !py-1 text-xs"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Labelled>
          )}
          {/* Dates commit on CHANGE, not blur: a mobile date picker doesn't
              reliably fire blur when you confirm a date, so an onBlur-only save
              silently dropped the value (beta report: "no option to save progress").
              Change fires the moment a full date is picked, like the selects. */}
          {!fp.hidden("target_date") && (
            <Labelled label={fp.label("target_date", "target date")}>
              <ProjectInput
                type="date"
                value={project.data.target_date ?? ""}
                commitOn="change"
                onCommit={(v) => updateProject.mutate({ target_date: v || null })}
                className="input !w-auto !py-1 text-xs"
              />
            </Labelled>
          )}
          <Labelled label="completed">
            <ProjectInput
              type="date"
              value={project.data.completion_date ?? ""}
              commitOn="change"
              onCommit={(v) => updateProject.mutate({ completion_date: v || null })}
              className="input !w-auto !py-1 text-xs"
            />
          </Labelled>
        </div>

        <div>
          <label className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 block mb-1">
            description
          </label>
          <DescriptionField
            value={project.data.description ?? ""}
            onCommit={(v) => updateProject.mutate({ description: v || null })}
          />
        </div>

        {/* Custom + Pillar-E contributed fields (workshop-mods etc.).
            Without this, migrated mod metadata — substate, energy,
            excitement — would be invisible on the detail page. */}
        <CustomFieldsPanel
          entityKind={entityKind}
          values={project.data.metadata}
          onCommit={(name, value) =>
            updateProject.mutate({
              metadata: { [name]: value },
            })
          }
        />
      </div>

      <PatternNeedsPanel designId={project.data.id} api={api} bodyText={project.data.description} />

      <DesignFiles designId={project.data.id} />

      <MaterialsPanel designId={project.data.id} status={project.data.status} api={api} />

      <HooksNeededPanel
        api={api}
        neededIds={
          Array.isArray((project.data.metadata as Record<string, unknown>)?.hooks_needed)
            ? ((project.data.metadata as Record<string, unknown>).hooks_needed as string[])
            : []
        }
        onChange={(ids) =>
          updateProject.mutate({
            metadata: { hooks_needed: ids },
          })
        }
      />

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
          // tasks
        </div>
        <NewTaskInline projectId={id!} />
        {tasks.isLoading && <div className="text-xs text-faint dark:text-slate-500 mt-3">loading…</div>}
        {(tasks.data?.items ?? []).length === 0 && !tasks.isLoading && (
          <div className="text-xs text-faint dark:text-slate-500 italic mt-3">No tasks yet.</div>
        )}
        <ul className="space-y-1 mt-3">
          {tasks.data?.items.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      </div>

      {/* Tags, discussion, and anything else contributed at every kind. Keyed
          off the INSTANCE kind, so a Designs instance's conversation is about
          the design rather than about "a project". */}
      <ContributedDetailPanels
        target={entityKind}
        ctx={{ slug: orgSlug, entityId: project.data.id, entityTitle: project.data.name }}
      />
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 items-center">
      <label className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        {label}
      </label>
      {children}
    </div>
  );
}

// Every field on this page auto-saves (on change/blur) — there is no Save
// button. This tiny status pill makes that visible so a user who's used to
// clicking "save" can see their edits are being persisted ("no option to save
// progress", beta report). Idle before the first edit → renders nothing.
function SaveStatus({
  saving,
  saved,
  failed,
  className = "",
}: {
  saving: boolean;
  saved: boolean;
  failed: boolean;
  className?: string;
}) {
  if (!saving && !saved && !failed) return null;
  const [text, tone] = failed
    ? ["couldn't save", "text-ember-500"]
    : saving
      ? ["saving…", "text-faint dark:text-slate-500"]
      : ["saved", "text-moss-600"];
  return (
    <span
      aria-live="polite"
      className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest ${tone} ${className}`}
    >
      {saved && !saving && !failed && <Check size={11} />}
      {text}
    </span>
  );
}

function NewTaskInline({ projectId }: { projectId: string }) {
  const { api } = useProjects();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [energy, setEnergy] = useState<"small" | "medium" | "large">("medium");

  const create = useMutation({
    mutationFn: () => api.createTask({ project_id: projectId, title: title.trim(), energy }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-tasks", projectId] });
      setTitle("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate();
  }

  return (
    <>
    <form onSubmit={submit} className="flex gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="new task…"
        className="input flex-1"
      />
      <select
        value={energy}
        onChange={(e) => setEnergy(e.target.value as "small" | "medium" | "large")}
        className="input !w-auto text-xs"
      >
        <option value="small">small</option>
        <option value="medium">medium</option>
        <option value="large">large</option>
      </select>
      <button
        type="submit"
        disabled={create.isPending || !title.trim()}
        className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 transition disabled:opacity-50 flex items-center gap-1"
      >
        <Plus size={12} /> Add
      </button>
    </form>
    <MutationError mutation={create} className="block mt-1" />
    </>
  );
}

function TaskRow({ task }: { task: Task }) {
  const { api } = useProjects();
  const qc = useQueryClient();
  const setStatus = useMutation({
    mutationFn: (status: TaskStatus) => api.updateTask(task.id, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project-tasks", task.project_id] }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTask(task.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project-tasks", task.project_id] }),
  });

  const done = task.status === "done";
  const blocked = (task.blocked_deps ?? 0) > 0;

  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 group">
      <button
        onClick={() => setStatus.mutate(done ? "todo" : "done")}
        className={
          "w-4 h-4 rounded border flex items-center justify-center shrink-0 transition " +
          (done
            ? "bg-moss-500 border-moss-500"
            : "border-line hover:border-accent")
        }
      >
        {done && <Check size={11} className="text-mortar-50" />}
      </button>
      <span
        className={
          "text-sm flex-1 min-w-0 break-words " + (done ? "line-through text-faint dark:text-slate-500" : "text-content dark:text-mortar-100")
        }
      >
        {task.title}
      </span>
      {task.energy && (
        <span className="text-[10px] font-mono text-faint dark:text-slate-500 uppercase">{task.energy}</span>
      )}
      {blocked && (
        <span className="text-[10px] font-mono uppercase text-ember-500 bg-ember-50 px-1.5 py-0.5 rounded">
          blocked: {task.blocked_deps}
        </span>
      )}
      <EntityActionsBar
        entityKind="projects:task"
        entityId={task.id}
        className="hover-reveal transition"
      />
      <button
        onClick={() => remove.mutate()}
        className="hover-reveal text-faint dark:text-slate-600 hover:text-ember-500 transition"
      >
        <Trash2 size={13} />
      </button>
      <MutationError mutation={setStatus} className="basis-full" />
      <MutationError mutation={remove} className="basis-full" />
    </li>
  );
}

// ── Materials: reserve inventory (yarn) against this design ────────────
// Reserved while the design is open → consumed (stock decrements) when it's
// marked done → released (stock restored) if abandoned. Renders nothing when
// the inventory module isn't enabled (the cross-module calls 404).
function MaterialsPanel({
  designId,
  status,
  api,
}: {
  designId: string;
  status: ProjectStatus;
  api: ProjectsApi;
}) {
  const qc = useQueryClient();
  const units = useUnits();
  const allocs = useQuery({
    queryKey: ["design-allocations", designId],
    queryFn: () => api.listDesignAllocations(designId),
    retry: false,
  });
  // The picker searches the stash itself; the panel only keeps the pick.
  const [picked, setPicked] = useState<InvPart | null>(null);
  const partId = picked?.id ?? "";
  const [amount, setAmount] = useState("");
  const reserve = useMutation({
    mutationFn: () => api.reserveYarn(designId, partId, Number(amount)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["design-allocations", designId] });
      void qc.invalidateQueries({ queryKey: [PART_PICKER_KEY] });
      setPicked(null);
      setAmount("");
    },
  });
  const setAllocStatus = useMutation({
    mutationFn: (v: { id: string; status: "consumed" | "released" }) =>
      api.setAllocationStatus(v.id, v.status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["design-allocations", designId] });
      void qc.invalidateQueries({ queryKey: [PART_PICKER_KEY] });
    },
  });

  // Inventory module not enabled → the allocations read errors; show nothing.
  if (allocs.isError) return null;
  const items = allocs.data?.items ?? [];
  const label: Record<string, string> = { reserved: "reserved", consumed: "used", released: "returned" };
  const open = status !== "done" && status !== "abandoned";

  return (
    <div
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5"
      data-testid="design-materials-panel"
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
        // materials for this design
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-faint dark:text-slate-500 mb-3">
          No yarn / materials reserved yet. Reserve some below - it stays reserved while you
          work, and is used up (stock decrements) when you set this page's status to{" "}
          <span className="font-medium">done</span>.
        </p>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <span
                className={`text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${
                  a.status === "reserved"
                    ? "text-accent border-cobble-200 dark:border-cobble-800"
                    : a.status === "consumed"
                      ? "text-faint border-line dark:border-slate-700"
                      : "text-moss-600 border-moss-200 dark:border-moss-800"
                }`}
              >
                {label[a.status]}
              </span>
              <span className="text-content dark:text-mortar-100">{a.part_name ?? "(unknown)"}</span>
              <span className="font-mono text-xs text-muted dark:text-slate-400">{Number(a.qty)}</span>
              {a.status === "reserved" && (
                <span className="ml-auto flex gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => setAllocStatus.mutate({ id: a.id, status: "consumed" })}
                    className="text-xs text-accent hover:underline"
                  >
                    use up
                  </button>
                  <button
                    type="button"
                    onClick={() => setAllocStatus.mutate({ id: a.id, status: "released" })}
                    className="text-xs text-faint hover:text-ember-500"
                  >
                    return
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <MutationError mutation={setAllocStatus} className="block mb-2" />
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (partId && Number(amount) > 0) reserve.mutate();
          }}
          className="flex items-center gap-2"
        >
          <PartPicker
            api={api}
            value={picked}
            onChange={setPicked}
            placeholder="Search yarn / material…"
            describe={(p) => `(${[p.available_qty, units.suffix(p.unit)].filter(Boolean).join(" ")} free)`}
          />
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            min="0"
            step="any"
            placeholder="amount"
            className="input text-sm w-32"
          />
          <button
            type="submit"
            disabled={!partId || !(Number(amount) > 0) || reserve.isPending}
            className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
          >
            <Plus size={14} /> Reserve
          </button>
        </form>
      )}
      <MutationError mutation={reserve} className="block mt-2" />
    </div>
  );
}

// ── Hooks needed: which hooks this design calls for + are they in stock ──
// Unlike yarn, hooks aren't consumed (you reuse them), so this is a link +
// availability check, not an allocation. Needed hook ids live in the design's
// metadata.hooks_needed; "hooks" are inventory parts that carry a hook_gauge.
function HooksNeededPanel({
  neededIds,
  onChange,
  api,
}: {
  neededIds: string[];
  onChange: (ids: string[]) => void;
  api: ProjectsApi;
}) {
  // The hooks this design already lists, read by id across every instance:
  // a hook past the first page of the stash used to vanish from this list
  // (the ids were looked up in one capped page, #3129).
  const needed = useQuery({
    queryKey: [PART_PICKER_KEY, "by-id", neededIds],
    queryFn: () => api.listInventoryParts({ ids: neededIds, limit: 200 }),
    enabled: neededIds.length > 0,
    retry: false,
  });
  // Whether the stash has any hooks at all, for the empty state: the first
  // page says so when it IS the whole stash; a bigger stash gets the picker.
  const firstPage = useQuery({
    queryKey: [PART_PICKER_KEY, ""],
    queryFn: () => api.listInventoryParts({ limit: 50 }),
    retry: false,
    staleTime: 30_000,
  });
  const [pick, setPick] = useState<InvPart | null>(null);
  if (needed.isError || firstPage.isError) return null; // inventory not enabled
  const isHook = (p: { metadata?: Record<string, unknown> | null }) =>
    !!(p.metadata && (p.metadata.hook_gauge || p.metadata.hook_material));
  const byId = new Map((needed.data?.items ?? []).map((p) => [p.id, p]));
  const neededParts = neededIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  const stashHasHooks = !!firstPage.data?.next_cursor || (firstPage.data?.items ?? []).some(isHook);
  const gauge = (p: { metadata?: Record<string, unknown> | null }) =>
    (p.metadata?.hook_gauge as string | undefined) ?? "";

  return (
    <div
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5"
      data-testid="design-hooks-panel"
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
        // hooks needed
      </div>
      {neededParts.length === 0 ? (
        <p className="text-xs text-faint dark:text-slate-500 mb-3">
          No hooks listed for this design yet. Add the ones the pattern calls for and
          you'll see at a glance whether they're in your stash.
        </p>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {neededParts.map((h) => {
            const inStock = Number(h.available_qty) > 0;
            return (
              <li key={h.id} className="flex items-center gap-2 text-sm">
                <span
                  className={`text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${
                    inStock
                      ? "text-moss-600 border-moss-200 dark:border-moss-800"
                      : "text-ember-500 border-ember-200 dark:border-ember-800"
                  }`}
                >
                  {inStock ? `in stock · ${h.available_qty}` : "out of stock"}
                </span>
                <span className="text-content dark:text-mortar-100">{h.name}</span>
                {gauge(h) && (
                  <span className="font-mono text-xs text-muted dark:text-slate-400">{gauge(h)}</span>
                )}
                <button
                  type="button"
                  onClick={() => onChange(neededIds.filter((x) => x !== h.id))}
                  className="ml-auto text-xs text-faint hover:text-ember-500 shrink-0"
                >
                  remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!stashHasHooks ? (
        <p className="text-[11px] text-faint dark:text-slate-500 italic">
          No hooks in your inventory yet - add some (with a gauge) to track them here.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <PartPicker
            api={api}
            value={pick}
            onChange={setPick}
            placeholder="Search for a hook this design needs…"
            include={(h) => isHook(h) && !neededIds.includes(h.id)}
            describe={(h) => (gauge(h) ? `(${gauge(h)})` : "")}
            emptyHint="No hooks match"
          />
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              if (pick) onChange([...neededIds, pick.id]);
              setPick(null);
            }}
            className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      )}
    </div>
  );
}
