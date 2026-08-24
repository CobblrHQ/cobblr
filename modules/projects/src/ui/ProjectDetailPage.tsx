// Project detail — header + inline tasks list. Tasks are added,
// checked off, deleted inline. Cross-module dependencies render as
// pill chips on the task row.

import { useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { ContributedDetailPanels, EntityActionsBar, CustomFieldsPanel, Modal, usePageTitle } from "@cobblr/platform-web";
import { useProjects } from "./context";
import { DesignFiles } from "./DesignFiles";
import { useFieldPresentation } from "./useFieldPresentation";
import type { PatternExtract, Priority, ProjectStatus, ProjectsApi, Task, TaskStatus } from "./api";

const PROJECT_STATUSES: ProjectStatus[] = ["planning", "active", "blocked", "done", "abandoned"];
const PRIORITIES: Priority[] = ["low", "med", "high", "urgent"];

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

  // Status drives the allocation lifecycle: finishing a project USES UP its
  // reserved inventory (consume → stock decrements); abandoning RETURNS it
  // (release → stock restored). Wrapped in try/catch so projects without the
  // inventory module just change status. (Re-opening doesn't un-consume — a
  // finished design's yarn is gone; that's the point.)
  async function handleStatusChange(newStatus: string) {
    await updateProject.mutateAsync({ status: newStatus });
    if (newStatus !== "done" && newStatus !== "abandoned") return;
    try {
      const { items } = await api.listDesignAllocations(id!);
      const reserved = items.filter((a) => a.status === "reserved");
      await Promise.all(
        reserved.map((a) =>
          api.setAllocationStatus(a.id, newStatus === "done" ? "consumed" : "released"),
        ),
      );
      void qc.invalidateQueries({ queryKey: ["design-allocations", id] });
      void qc.invalidateQueries({ queryKey: ["inv-parts-for-alloc"] });
    } catch {
      /* inventory module not enabled — nothing to settle */
    }
  }

  if (project.isLoading) return <div className="text-sm text-faint dark:text-slate-500">loading…</div>;
  if (!project.data) return <div className="text-sm text-ember-500">Project not found.</div>;

  return (
    <div className="space-y-5 max-w-3xl">
      <Link to={backPath} className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent">
        <ArrowLeft size={12} /> back to {backLabel}
      </Link>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-start gap-3">
          <input
            defaultValue={project.data.name}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value !== project.data!.name) {
                updateProject.mutate({ name: e.target.value.trim() });
              }
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
              <input
                type="date"
                defaultValue={project.data.target_date ?? ""}
                onChange={(e) =>
                  updateProject.mutate({ target_date: e.target.value || null })
                }
                className="input !w-auto !py-1 text-xs"
              />
            </Labelled>
          )}
          <Labelled label="completed">
            <input
              type="date"
              defaultValue={project.data.completion_date ?? ""}
              onChange={(e) =>
                updateProject.mutate({ completion_date: e.target.value || null })
              }
              className="input !w-auto !py-1 text-xs"
            />
          </Labelled>
        </div>

        <div>
          <label className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 block mb-1">
            description
          </label>
          <AutoGrowTextarea
            defaultValue={project.data.description ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (project.data!.description ?? "")) {
                updateProject.mutate({ description: v || null });
              }
            }}
            minRows={3}
            placeholder="What is this project about?"
            className="input text-sm w-full resize-y"
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
              metadata: { ...project.data!.metadata, [name]: value },
            })
          }
        />
      </div>

      <PatternExtractPanel
        designId={project.data.id}
        api={api}
        onAddHooks={(ids) => {
          const cur = Array.isArray((project.data!.metadata as Record<string, unknown>)?.hooks_needed)
            ? ((project.data!.metadata as Record<string, unknown>).hooks_needed as string[])
            : [];
          updateProject.mutate({
            metadata: { ...project.data!.metadata, hooks_needed: Array.from(new Set([...cur, ...ids])) },
          });
        }}
      />

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
            metadata: { ...project.data!.metadata, hooks_needed: ids },
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
    <li className="flex items-center gap-2 py-1.5 group">
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
  const allocs = useQuery({
    queryKey: ["design-allocations", designId],
    queryFn: () => api.listDesignAllocations(designId),
    retry: false,
  });
  const parts = useQuery({
    queryKey: ["inv-parts-for-alloc"],
    queryFn: () => api.listInventoryParts(),
    retry: false,
  });
  const [partId, setPartId] = useState("");
  const [amount, setAmount] = useState("");
  const reserve = useMutation({
    mutationFn: () => api.reserveYarn(designId, partId, Number(amount)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["design-allocations", designId] });
      void qc.invalidateQueries({ queryKey: ["inv-parts-for-alloc"] });
      setPartId("");
      setAmount("");
    },
  });
  const setAllocStatus = useMutation({
    mutationFn: (v: { id: string; status: "consumed" | "released" }) =>
      api.setAllocationStatus(v.id, v.status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["design-allocations", designId] });
      void qc.invalidateQueries({ queryKey: ["inv-parts-for-alloc"] });
    },
  });

  // Inventory module not enabled → both queries error; show nothing.
  if (allocs.isError || parts.isError) return null;
  const items = allocs.data?.items ?? [];
  const partsList = parts.data?.items ?? [];
  const selPart = partsList.find((p) => p.id === partId);
  const label: Record<string, string> = { reserved: "reserved", consumed: "used", released: "returned" };
  const open = status !== "done" && status !== "abandoned";

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
        // materials for this design
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-faint dark:text-slate-500 mb-3">
          No yarn / materials reserved yet. Reserve some below - it stays reserved while you
          work, and is used up (stock decrements) when you mark this design{" "}
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
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (partId && Number(amount) > 0) reserve.mutate();
          }}
          className="flex items-center gap-2"
        >
          <select
            value={partId}
            onChange={(e) => setPartId(e.target.value)}
            className="input text-sm flex-1"
          >
            <option value="">Pick yarn / material…</option>
            {partsList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.available_qty} {p.unit} free)
              </option>
            ))}
          </select>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            min="0"
            step="any"
            placeholder={selPart ? `amount (${selPart.unit})` : "amount"}
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
  const parts = useQuery({
    queryKey: ["inv-parts-for-alloc"],
    queryFn: () => api.listInventoryParts(),
    retry: false,
  });
  const [pick, setPick] = useState("");
  if (parts.isError) return null; // inventory not enabled
  const all = parts.data?.items ?? [];
  const isHook = (p: { metadata?: Record<string, unknown> | null }) =>
    !!(p.metadata && (p.metadata.hook_gauge || p.metadata.hook_material));
  const hooks = all.filter(isHook);
  const byId = new Map(all.map((p) => [p.id, p]));
  const needed = neededIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  const addable = hooks.filter((h) => !neededIds.includes(h.id));
  const gauge = (p: { metadata?: Record<string, unknown> | null }) =>
    (p.metadata?.hook_gauge as string | undefined) ?? "";

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
        // hooks needed
      </div>
      {needed.length === 0 ? (
        <p className="text-xs text-faint dark:text-slate-500 mb-3">
          No hooks listed for this design yet. Add the ones the pattern calls for and
          you'll see at a glance whether they're in your stash.
        </p>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {needed.map((h) => {
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
      {hooks.length === 0 ? (
        <p className="text-[11px] text-faint dark:text-slate-500 italic">
          No hooks in your inventory yet - add some (with a gauge) to track them here.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="input text-sm flex-1"
          >
            <option value="">Add a hook this design needs…</option>
            {addable.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {gauge(h) ? ` (${gauge(h)})` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              if (pick) onChange([...neededIds, pick]);
              setPick("");
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

// ── AI: extract yarn + hooks from a pasted pattern (Phase 3) ───────────
// Pattern text → core-ai → a structured materials list. Yarn is shown as
// guidance (reserve it in the Materials panel); matched hooks can be added
// to "hooks needed" in one tap. Degrades cleanly when no AI provider is set.
function PatternExtractPanel({
  designId,
  api,
  onAddHooks,
}: {
  designId: string;
  api: ProjectsApi;
  onAddHooks: (ids: string[]) => void;
}) {
  const { orgSlug, getToken } = useProjects();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [patternName, setPatternName] = useState<string | null>(null);
  const [result, setResult] = useState<PatternExtract | null>(null);
  const parts = useQuery({
    queryKey: ["inv-parts-for-alloc"],
    queryFn: () => api.listInventoryParts(),
    retry: false,
  });
  const extract = useMutation({
    mutationFn: () => api.extractPattern(designId, text),
    onSuccess: (r) => setResult(r),
  });
  // The "store the pattern" path: upload the PDF to core-files, attach it to
  // this design (role=pattern — it lives on the design like any file), then
  // let the server read it. The design becomes the bridge between the
  // pattern and the yarn/hooks actually on the shelf.
  const uploadExtract = useMutation({
    mutationFn: async (file: File) => {
      const t = getToken();
      const auth: Record<string, string> = t ? { Authorization: `Bearer ${t}` } : {};
      const base = `/api/v1/orgs/${orgSlug}/modules/core-files`;
      const fd = new FormData();
      fd.append("file", file);
      const ures = await fetch(`${base}/files`, { method: "POST", headers: auth, body: fd });
      if (!ures.ok) throw new Error(`upload ${ures.status}`);
      const uf = (await ures.json()) as { id: string };
      await fetch(`${base}/attachments`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: uf.id,
          source_module: "projects",
          source_type: "project",
          source_id: designId,
          role: "pattern",
        }),
      });
      setPatternName(file.name);
      return api.extractPatternFile(designId, uf.id);
    },
    onSuccess: (r) => setResult(r),
  });
  const busy = extract.isPending || uploadExtract.isPending;
  const norm = (v: string) => v.replace(/\s/g, "").toLowerCase();
  const matchedHookIds = () => {
    const all = parts.data?.items ?? [];
    const ids: string[] = [];
    for (const h of result?.hooks ?? []) {
      const g = norm(h.gauge ?? "");
      if (!g) continue;
      const m = all.find((p) => {
        const pg = norm(String((p.metadata as Record<string, unknown> | null)?.hook_gauge ?? ""));
        return pg && (pg === g || pg.startsWith(g) || g.startsWith(pg));
      });
      if (m) ids.push(m.id);
    }
    return Array.from(new Set(ids));
  };
  const matched = result?.ai ? matchedHookIds() : [];
  // Yarn requirement → the stash: a stock part matches when the pattern's
  // weight ("Worsted") or fiber ("acrylic") shows up on the part's
  // weight_class/fiber metadata or its name. Loose on purpose — it
  // suggests, the user reserves.
  const yarnMatch = (y: { weight?: string | null; fiber?: string | null }) => {
    const all = parts.data?.items ?? [];
    const w = norm(y.weight ?? "");
    const fb = norm(y.fiber ?? "");
    if (!w && !fb) return undefined;
    return all.find((p) => {
      const md = (p.metadata as Record<string, unknown> | null) ?? {};
      if (md.hook_gauge) return false; // hooks aren't yarn
      const hay = norm(`${p.name} ${String(md.weight_class ?? "")} ${String(md.fiber ?? "")}`);
      const wOk = w ? hay.includes(w) : false;
      const fOk = fb ? hay.includes(fb) : false;
      return (w && fb && wOk && fOk) || (w && !fb && wOk) || (!w && fb && fOk);
    });
  };
  const reserveMatch = useMutation({
    mutationFn: (v: { partId: string; qty: number }) => api.reserveYarn(designId, v.partId, v.qty),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["design-allocations", designId] });
      void qc.invalidateQueries({ queryKey: ["inv-parts-for-alloc"] });
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-content dark:hover:text-mortar-100 transition"
      >
        <Sparkles size={13} /> Suggest yarn &amp; hooks from the pattern
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Suggest from pattern"
        subtitle="Upload the pattern PDF (it's saved onto this design) or paste its materials section — the AI pulls out the yarn and hooks it calls for and checks them against your stash."
      >
        <label className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line dark:border-slate-600 px-3 py-2.5 mb-3 cursor-pointer hover:border-accent transition">
          <span className="inline-flex items-center gap-2 text-sm text-content dark:text-mortar-200">
            <Upload size={14} className="text-accent" />
            {patternName ?? "Upload the pattern (PDF)"}
          </span>
          <span className="text-[11px] text-faint dark:text-slate-500">
            {uploadExtract.isPending ? "reading…" : "saved to this design"}
          </span>
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadExtract.mutate(file);
              e.target.value = "";
            }}
          />
        </label>
        {uploadExtract.isError && (
          <p className="text-sm text-ember-600 dark:text-ember-400 mb-2">
            Couldn't read that PDF: {(uploadExtract.error as Error).message}
          </p>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="…or paste the materials section: “Worsted weight wool, ~400 m, in teal. 5 mm (H) crochet hook…”"
          className="input text-sm w-full resize-y mb-2"
        />
        <button
          type="button"
          disabled={!text.trim() || busy}
          onClick={() => extract.mutate()}
          className="inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
        >
          <Sparkles size={14} /> {busy ? "Reading…" : "Extract"}
        </button>

        {result && !result.ai && (
          <p className="text-sm text-ember-600 dark:text-ember-400 mt-3">{result.reason}</p>
        )}
        {result?.ai && (
          <div className="mt-4 space-y-3">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">yarn</div>
              {result.yarn.length === 0 ? (
                <p className="text-xs text-faint dark:text-slate-500">None found.</p>
              ) : (
                <ul className="text-sm space-y-2">
                  {result.yarn.map((y, i) => {
                    const stock = yarnMatch(y);
                    const want = y.skeins ?? 1;
                    return (
                      <li key={i} className="text-content dark:text-mortar-200">
                        {[y.weight, y.fiber, y.color].filter(Boolean).join(" · ") || "yarn"}
                        {y.length_m ? <span className="text-muted dark:text-slate-400"> — {y.length_m} m</span> : null}
                        {y.skeins ? <span className="text-muted dark:text-slate-400"> ({y.skeins} skein{y.skeins === 1 ? "" : "s"})</span> : null}
                        {stock ? (
                          <span className="mt-1 flex items-center gap-2 text-xs">
                            <span className="text-moss-600">✓ in your stash: {stock.name} ({stock.available_qty} {stock.unit} free)</span>
                            <button
                              type="button"
                              disabled={reserveMatch.isPending || stock.available_qty <= 0}
                              onClick={() => reserveMatch.mutate({ partId: stock.id, qty: Math.min(want, stock.available_qty) })}
                              className="inline-flex items-center gap-1 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-0.5 disabled:opacity-40"
                            >
                              <Plus size={11} /> Reserve {Math.min(want, Math.max(stock.available_qty, 0))}
                            </button>
                          </span>
                        ) : (
                          <span className="block mt-0.5 text-xs text-faint dark:text-slate-500">not in the stash yet</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">hooks</div>
              {result.hooks.length === 0 ? (
                <p className="text-xs text-faint dark:text-slate-500">None found.</p>
              ) : (
                <ul className="text-sm space-y-1">
                  {result.hooks.map((h, i) => (
                    <li key={i} className="text-content dark:text-mortar-200">{h.gauge ?? "hook"}</li>
                  ))}
                </ul>
              )}
              {matched.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onAddHooks(matched);
                    setOpen(false);
                  }}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2"
                >
                  <Plus size={14} /> Add {matched.length} matching hook{matched.length === 1 ? "" : "s"} to “needed”
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
