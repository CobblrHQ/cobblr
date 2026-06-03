// Project detail — header + inline tasks list. Tasks are added,
// checked off, deleted inline. Cross-module dependencies render as
// pill chips on the task row.

import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, Trash2 } from "lucide-react";
import { EntityActionsBar, CustomFieldsPanel, usePageTitle } from "@cobblr/platform-web";
import { useProjects } from "./context";
import { useFieldPresentation } from "./useFieldPresentation";
import type { Priority, ProjectStatus, Task, TaskStatus } from "./api";

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
                onChange={(e) => updateProject.mutate({ status: e.target.value })}
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
