// Project detail — header + inline tasks list. Tasks are added,
// checked off, deleted inline. Cross-module dependencies render as
// pill chips on the task row.

import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, Sparkles, Trash2 } from "lucide-react";
import { EntityActionsBar, CustomFieldsPanel, Modal, usePageTitle } from "@cobblr/platform-web";
import { useProjects } from "./context";
import { useFieldPresentation } from "./useFieldPresentation";
import type { PatternExtract, Priority, ProjectStatus, ProjectsApi, Task, TaskStatus } from "./api";

const PROJECT_STATUSES: ProjectStatus[] = ["planning", "active", "blocked", "done", "abandoned"];
const PRIORITIES: Priority[] = ["low", "med", "high", "urgent"];

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useProjects();
  // Native-field presentation (relabel + show/hide via bundle/config); no-op
  // until an override exists. Matches the assets/inventory pattern.
  const fp = useFieldPresentation("projects:project");
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
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent">
        <ArrowLeft size={12} /> back to projects
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
            className="font-display text-2xl font-bold text-content dark:text-mortar-100 bg-transparent flex-1 focus:outline-none focus:bg-subtle dark:focus:bg-slate-800/70 rounded px-1"
          />
          <EntityActionsBar entityKind="projects:project" entityId={project.data.id} className="mt-1" />
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
          {!fp.hidden("target_date") && (
            <Labelled label={fp.label("target_date", "target date")}>
              <input
                type="date"
                defaultValue={project.data.target_date ?? ""}
                onBlur={(e) =>
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
              onBlur={(e) =>
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
          <textarea
            defaultValue={project.data.description ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (project.data!.description ?? "")) {
                updateProject.mutate({ description: v || null });
              }
            }}
            rows={2}
            placeholder="What is this project about?"
            className="input text-sm w-full resize-y"
          />
        </div>

        {/* Custom + Pillar-E contributed fields (workshop-mods etc.).
            Without this, migrated mod metadata — substate, energy,
            excitement — would be invisible on the detail page. */}
        <CustomFieldsPanel
          entityKind="projects:project"
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
          "text-sm flex-1 " + (done ? "line-through text-faint dark:text-slate-500" : "text-content dark:text-mortar-100")
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
        className="opacity-0 group-hover:opacity-100 transition"
      />
      <button
        onClick={() => remove.mutate()}
        className="opacity-0 group-hover:opacity-100 text-faint dark:text-slate-600 hover:text-ember-500 transition"
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
          No yarn / materials reserved yet. Reserve some below — it stays reserved while you
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
          No hooks in your inventory yet — add some (with a gauge) to track them here.
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
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
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
  const norm = (s: string) => s.replace(/\s/g, "").toLowerCase();
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
        subtitle="Paste the pattern's materials section — the AI pulls out the yarn and hooks it calls for."
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="e.g. “Worsted weight wool, ~400 m, in teal. 5 mm (H) crochet hook…”"
          className="input text-sm w-full resize-y mb-2"
        />
        <button
          type="button"
          disabled={!text.trim() || extract.isPending}
          onClick={() => extract.mutate()}
          className="inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
        >
          <Sparkles size={14} /> {extract.isPending ? "Reading…" : "Extract"}
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
                <ul className="text-sm space-y-1">
                  {result.yarn.map((y, i) => (
                    <li key={i} className="text-content dark:text-mortar-200">
                      {[y.weight, y.fiber, y.color].filter(Boolean).join(" · ") || "yarn"}
                      {y.length_m ? <span className="text-muted dark:text-slate-400"> — {y.length_m} m</span> : null}
                      {y.skeins ? <span className="text-muted dark:text-slate-400"> ({y.skeins} skein{y.skeins === 1 ? "" : "s"})</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-faint dark:text-slate-500 mt-1">Reserve these in “Materials” below.</p>
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
