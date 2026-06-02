// Projects index. Status-grouped list + search + new-project form.

import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "lucide-react";
import { BulkActionBar, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { useProjects } from "./context";
import type { Project } from "./api";

const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
  abandoned: "Abandoned",
};
const STATUS_ORDER = ["planning", "active", "blocked", "done", "abandoned"];

export function ProjectsListPage() {
  usePageTitle("Projects");
  const { api } = useProjects();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["projects-list"], queryFn: () => api.listProjects() });
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");

  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects-list"] });
      setName("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  const items = list.data?.items ?? [];
  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  const grouped = useMemo(() => {
    const m = new Map<string, Project[]>();
    for (const p of filtered) {
      const arr = m.get(p.status) ?? [];
      arr.push(p);
      m.set(p.status, arr);
    }
    return m;
  }, [filtered]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toast = useToast();
  const confirm = useConfirm();
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api.deleteProject(id);
      }
    },
    onSuccess: () => {
      toast.success(`Deleted ${selected.size} project${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["projects-list"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  function toggleRow(id: string, checked: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (checked) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">projects</h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          {query ? `${filtered.length} of ${items.length}` : `${items.length} total`}
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search…"
            className="input !py-1 !pl-7 !text-xs !w-48"
          />
        </div>
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new project name…"
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
        >
          <Plus size={14} /> New project
        </button>
      </form>

      {items.length === 0 && !list.isLoading && (
        <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-12 text-center text-faint dark:text-slate-500">
          No projects yet — create one above.
        </div>
      )}
      {items.length > 0 && filtered.length === 0 && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No projects match "{query}".
        </div>
      )}

      {STATUS_ORDER.map((s) => {
        const rows = grouped.get(s) ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={s}>
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
              // {STATUS_LABEL[s] ?? s}{" "}
              <span className="text-faint dark:text-slate-500">({rows.length})</span>
            </div>
            <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-700">
              {rows.map((p) => (
                <li key={p.id} className="flex items-stretch">
                  <label
                    className="flex items-center px-3 cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={(e) => toggleRow(p.id, e.target.checked)}
                      className="accent-cobble-600"
                      aria-label={`Select ${p.name}`}
                    />
                  </label>
                  <Link
                    to={`/projects/${p.id}`}
                    className="flex-1 px-2 py-3 hover:bg-subtle dark:hover:bg-slate-800/70 transition"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="font-medium text-content dark:text-mortar-100">{p.name}</span>
                      {p.priority && (
                        <span className="text-[10px] font-mono text-faint dark:text-slate-500 uppercase">
                          {p.priority}
                        </span>
                      )}
                      <Excitement value={p.metadata?.excitement} />
                      <span className="flex-1" />
                      {p.target_date && (
                        <span className="text-[11px] font-mono text-faint dark:text-slate-500 shrink-0">
                          target {new Date(p.target_date).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-0.5 text-xs text-muted dark:text-slate-400 line-clamp-1">
                        {p.description}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <button
            type="button"
            disabled={bulkDelete.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: `Delete ${selected.size} project${selected.size === 1 ? "" : "s"}?`,
                message: "Tasks belonging to these projects stay (their project_id goes null). The project rows themselves are removed.",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) bulkDelete.mutate(Array.from(selected));
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 hover:text-ember-700 disabled:opacity-50"
          >
            <Trash2 size={12} /> Delete
          </button>
        }
      />
    </div>
  );
}

/** Migrated mods carry an `excitement` (0-5) in metadata. Render it
 *  as a compact dot meter so the list stays scannable. */
function Excitement({ value }: { value: unknown }) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const clamped = Math.min(5, Math.max(0, Math.round(n)));
  return (
    <span className="flex items-center gap-0.5 shrink-0" title={`excitement ${clamped}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={
            "w-1 h-1 rounded-full " +
            (i < clamped ? "bg-cobble-400" : "bg-subtle dark:bg-slate-700")
          }
        />
      ))}
    </span>
  );
}
