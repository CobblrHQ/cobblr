import { RecordFormModal, ContributedDetailPanels, CustomFieldsPanel, EntityActionsBar, FieldPack, MutationError, fieldNeed, useConfirm, useFieldDraft, useRecordEdits } from "@cobblr/platform-web";
// One task, whole: everything a task has, settable in one place. The row on a
// project shows a line of it; this sheet is where the due date, the details,
// the priority, the status and what it waits on are read and changed, and
// where it is deleted. Opened from the row, and by address
// (/projects/tasks/<id>), which is where a search result or the assistant
// sends a person.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useProjects } from "./context";
import type { ChecklistItem, Energy, Priority, Task, TaskDependency, TaskStatus } from "./api";
import { dayHere } from "@cobblr/platform-contract/day";
import { fieldDay } from "@cobblr/platform-contract/field-day";

const STATUSES: { v: TaskStatus; label: string }[] = [
  { v: "todo", label: "To do" },
  { v: "doing", label: "Doing" },
  { v: "done", label: "Done" },
  { v: "blocked", label: "On hold" },
  { v: "cancelled", label: "Cancelled" },
];
const PRIORITIES: { v: Priority; label: string }[] = [
  { v: "low", label: "Low" },
  { v: "med", label: "Normal" },
  { v: "high", label: "High" },
  { v: "urgent", label: "Urgent" },
];
const ENERGIES: { v: Energy; label: string }[] = [
  { v: "small", label: "Small" },
  { v: "medium", label: "Medium" },
  { v: "large", label: "Large" },
];

export const taskKey = (id: string) => ["project-task", id] as const;

/** The calendar day a stored due date means, for a date input. */
export function dueDay(due: string | null): string {
  return fieldDay(due) ?? "";
}

/** A due day read against the person's own today: past it is late. */
export function dueState(due: string | null, status: TaskStatus, today: string): "late" | "today" | "upcoming" | null {
  if (!due || status === "done" || status === "cancelled") return null;
  const d = dueDay(due);
  return d < today ? "late" : d === today ? "today" : "upcoming";
}

export function localToday(): string {
  return dayHere();
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">{label}</span>
      {children}
    </label>
  );
}

/** A select or date over one saved value: shows the choice at once and
 *  follows the record while untouched (useFieldDraft), so a pick never snaps
 *  back while the save is on its way. */
function DraftInput({
  value,
  onCommit,
  children,
  ...rest
}: { value: string; onCommit: (v: string) => void; children?: ReactNode; "aria-label": string; type?: "date" }) {
  const f = useFieldDraft(value);
  const commit = (v: string) => {
    f.setDraft(v);
    f.committed(v);
    onCommit(v);
  };
  return children ? (
    <select {...rest} className="input text-sm" value={f.draft} onChange={(e) => commit(e.target.value)}>
      {children}
    </select>
  ) : (
    <input {...rest} className="input text-sm" value={f.draft} onChange={(e) => commit(e.target.value)} />
  );
}

function TextCommit({ value, onCommit, multiline, ...rest }: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; "aria-label"?: string }) {
  const f = useFieldDraft(value);
  const commit = (v: string) => {
    if (v === value) return;
    f.committed(v);
    onCommit(v);
  };
  return multiline ? (
    <textarea
      {...rest}
      rows={4}
      value={f.draft}
      onChange={(e) => f.setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      className="input text-sm w-full resize-y"
    />
  ) : (
    <input
      {...rest}
      value={f.draft}
      onChange={(e) => f.setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className="input text-sm w-full"
    />
  );
}

export function TaskSheet({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { api, orgSlug } = useProjects();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const task = useQuery({ queryKey: taskKey(taskId), queryFn: () => api.getTask(taskId) });
  const t = task.data;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: taskKey(taskId) });
    if (t?.project_id) void qc.invalidateQueries({ queryKey: ["project-tasks", t.project_id] });
  };
  // Judged against the task as this sheet shows it (#7925).
  const edits = useRecordEdits(t);
  const update = useMutation({ mutationFn: (patch: Record<string, unknown>) => edits(patch, (e) => api.updateTask(taskId, e)), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api.deleteTask(taskId),
    onSuccess: () => {
      if (t?.project_id) void qc.invalidateQueries({ queryKey: ["project-tasks", t.project_id] });
      onClose();
    },
  });

  return (
    <RecordFormModal open onClose={onClose} title={t?.title ?? "Task"} subtitle={t?.project_name ?? undefined}>
      {task.isLoading && <div className="text-xs text-faint dark:text-slate-500">loading…</div>}
      {task.isError && <div className="text-sm text-ember-600 dark:text-ember-400">This task could not be opened. It may have been deleted.</div>}
      {t && (
        <div className="space-y-4" data-testid="task-sheet">
          <Field label="Task">
            <TextCommit aria-label="Task title" value={t.title} onCommit={(v) => v.trim() && update.mutate({ title: v.trim() })} />
          </Field>

          <FieldPack
            testId="task-fields"
            items={[
              {
                need: fieldNeed("status", { control: "choice", label: "Status", choices: STATUSES.map((x) => x.label) }),
                node: (
                  <Field label="Status">
                    <DraftInput aria-label="Status" value={t.status} onCommit={(v) => update.mutate({ status: v })}>
                      {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </DraftInput>
                  </Field>
                ),
              },
              {
                need: fieldNeed("due", { control: "date", label: "Due" }),
                node: (
                  <Field label="Due">
                    <DraftInput
                      aria-label="Due date"
                      type="date"
                      value={dueDay(t.due_date)}
                      onCommit={(v) => update.mutate({ due_date: v ? `${v}T12:00:00Z` : null })}
                    />
                  </Field>
                ),
              },
              {
                need: fieldNeed("priority", { control: "choice", label: "Priority", choices: PRIORITIES.map((x) => x.label) }),
                node: (
                  <Field label="Priority">
                    <DraftInput aria-label="Priority" value={t.priority ?? "med"} onCommit={(v) => update.mutate({ priority: v })}>
                      {PRIORITIES.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                    </DraftInput>
                  </Field>
                ),
              },
              {
                need: fieldNeed("size", { control: "choice", label: "Size", choices: ENERGIES.map((x) => x.label) }),
                node: (
                  <Field label="Size">
                    <DraftInput aria-label="Size" value={t.energy ?? "medium"} onCommit={(v) => update.mutate({ energy: v })}>
                      {ENERGIES.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                    </DraftInput>
                  </Field>
                ),
              },
            ]}
          />

          <Repeats value={t.repeat ?? null} onChange={(repeat) => update.mutate({ repeat })} />

          <Field label="Details">
            <TextCommit multiline aria-label="Details" placeholder="What done looks like, notes, links" value={t.description ?? ""} onCommit={(v) => update.mutate({ description: v || null })} />
          </Field>

          <Checklist items={t.checklist ?? []} onSave={(checklist) => update.mutate({ checklist })} />

          <WaitsOn task={t} dependencies={t.dependencies} onChanged={refresh} />

          <CustomFieldsPanel
            entityKind="projects:task"
            values={t.metadata}
            onCommit={(name, value) => update.mutate({ metadata: { [name]: value } })}
          />

          <MutationError mutation={update} className="block" />

          <div className="flex items-center gap-2 border-t border-line dark:border-slate-700 pt-3">
            <EntityActionsBar entityKind="projects:task" entityId={t.id} />
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 text-xs text-ember-600 hover:text-ember-700 dark:text-ember-400 dark:hover:text-ember-300"
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete "${t.title}"?`,
                  message: t.dependencies.length > 0 ? "It also stops waiting on what it waits on. This can't be undone." : "This can't be undone.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) remove.mutate();
              }}
            >
              <Trash2 size={13} /> Delete task
            </button>
          </div>
          <MutationError mutation={remove} className="block" />

          <ContributedDetailPanels target="projects:task" ctx={{ slug: orgSlug, entityId: t.id, entityTitle: t.title }} />
        </div>
      )}
    </RecordFormModal>
  );
}

function WaitsOn({ task, dependencies: given, onChanged }: { task: Task; dependencies?: TaskDependency[] | null; onChanged: () => void }) {
  // A task read without its dependency list (an older answer, a narrower read) waits on nothing.
  const dependencies = given ?? [];
  const { api } = useProjects();
  const [pick, setPick] = useState("");
  const siblings = useQuery({
    queryKey: ["project-tasks", task.project_id],
    queryFn: () => api.listTasks({ project_id: task.project_id ?? undefined }),
    enabled: !!task.project_id,
  });
  const already = new Set(dependencies.map((d) => d.depends_on_task_id).filter(Boolean));
  const options = (siblings.data?.items ?? []).filter((o) => o.id !== task.id && !already.has(o.id));
  const add = useMutation({
    mutationFn: (dependsOn: string) => api.addDependency(task.id, { depends_on_task_id: dependsOn }),
    onSuccess: () => { setPick(""); onChanged(); },
  });
  const drop = useMutation({ mutationFn: (depId: string) => api.removeDependency(task.id, depId), onSuccess: onChanged });

  return (
    <div data-testid="task-waits-on">
      <div className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Waits on</div>
      {dependencies.length === 0 && <div className="text-xs text-faint dark:text-slate-500 italic">Nothing. It can start any time.</div>}
      <ul className="space-y-1">
        {dependencies.map((d) => (
          <li key={d.id} className="flex items-center gap-2 text-sm">
            <span className={"text-[10px] uppercase px-1.5 py-0.5 rounded " + (d.open ? "text-ember-600 bg-ember-50 dark:text-ember-300 dark:bg-ember-900/30" : "text-moss-700 bg-moss-50 dark:text-moss-300 dark:bg-moss-900/30")}>
              {d.open ? "waiting" : "clear"}
            </span>
            <span className="flex-1 min-w-0 truncate">
              {d.depends_on_task_id ? d.blocker_title ?? "a deleted task" : `${d.target_entity_type ?? "record"} ${d.target_entity_id?.slice(0, 8) ?? ""}`}
            </span>
            <button title="Stop waiting on this" type="button" aria-label="Stop waiting on this" className="text-faint hover:text-ember-600" onClick={() => drop.mutate(d.id)}>
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      {task.project_id && options.length > 0 && (
        <select
          aria-label="Add a task this one waits on"
          className="input text-sm mt-2"
          value={pick}
          onChange={(e) => { setPick(e.target.value); if (e.target.value) add.mutate(e.target.value); }}
        >
          <option value="">+ Waits on another task…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      )}
      <MutationError mutation={add} className="block mt-1" />
      <MutationError mutation={drop} className="block mt-1" />
    </div>
  );
}

/** "2 of 5" for a row: nothing when the task has no checklist. */
export function checklistProgress(items: readonly ChecklistItem[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  return `${items.filter((i) => i.done).length}/${items.length}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** The steps inside a task. Each change shows at once and saves the whole
 *  list, in order; the saved list replaces it when it comes back. */
function Checklist({ items: saved, onSave: save }: { items: ChecklistItem[]; onSave: (items: ChecklistItem[]) => void }) {
  const [text, setText] = useState("");
  const [items, setItems] = useState(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setItems(JSON.parse(savedKey) as ChecklistItem[]), [savedKey]);
  const onSave = (next: ChecklistItem[]) => {
    setItems(next);
    save(next);
  };
  const add = () => {
    if (!text.trim()) return;
    onSave([...items, { id: newId(), text: text.trim(), done: false }]);
    setText("");
  };
  return (
    <div data-testid="task-checklist">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">Checklist</span>
        {checklistProgress(items) && <span className="text-[10px] font-mono text-muted">{checklistProgress(items)} done</span>}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={`${it.text} done`}
              checked={it.done}
              onChange={() => onSave(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}
            />
            <span className={"flex-1 min-w-0 break-words " + (it.done ? "line-through text-faint" : "")}>{it.text}</span>
            <button title={`Remove ${it.text}`} type="button" aria-label={`Remove ${it.text}`} className="text-faint hover:text-ember-600" onClick={() => onSave(items.filter((x) => x.id !== it.id))}>
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input aria-label="Add a step" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a step" className="input text-sm flex-1" />
        <button type="submit" disabled={!text.trim()} className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2 text-xs text-mortar-50 disabled:opacity-50">
          <Plus size={12} /> Add
        </button>
      </form>
    </div>
  );
}

type Repeat = { every_n: number; every_unit: "day" | "week" | "month" | "year" };
const UNIT_WORDS: Record<Repeat["every_unit"], [string, string]> = { day: ["day", "days"], week: ["week", "weeks"], month: ["month", "months"], year: ["year", "years"] };

/** "Repeats every [3] [months]", or not at all. Finishing a repeating task
 *  makes the next one, due one interval later. */
function Repeats({ value: saved, onChange: save }: { value: Repeat | null; onChange: (v: Repeat | null) => void }) {
  // Shown at once, saved behind; the saved value replaces it when it returns.
  const [value, setValue] = useState(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setValue(JSON.parse(savedKey) as Repeat | null), [savedKey]);
  const onChange = (v: Repeat | null) => {
    setValue(v);
    save(v);
  };
  const [n, setN] = useState(String(saved?.every_n ?? 1));
  const on = !!value;
  const num = Math.max(1, Math.min(365, Math.round(Number(n)) || 1));
  return (
    <div data-testid="task-repeats" className="flex flex-wrap items-center gap-2 text-sm">
      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          aria-label="Repeats"
          checked={on}
          onChange={(e) => onChange(e.target.checked ? { every_n: num, every_unit: value?.every_unit ?? "week" } : null)}
        />
        Repeats
      </label>
      {on && (
        <>
          <span>every</span>
          <input
            type="number"
            min={1}
            max={365}
            aria-label="Every how many"
            value={n}
            onChange={(e) => setN(e.target.value)}
            onBlur={() => value && num !== value.every_n && onChange({ ...value, every_n: num })}
            className="input text-sm !w-16"
          />
          <select
            aria-label="Repeat unit"
            className="input text-sm !w-auto"
            value={value!.every_unit}
            onChange={(e) => onChange({ every_n: num, every_unit: e.target.value as Repeat["every_unit"] })}
          >
            {(Object.keys(UNIT_WORDS) as Repeat["every_unit"][]).map((u) => (
              <option key={u} value={u}>{UNIT_WORDS[u][num === 1 ? 0 : 1]}</option>
            ))}
          </select>
          <span className="text-xs text-muted">Done makes the next one.</span>
        </>
      )}
    </div>
  );
}
