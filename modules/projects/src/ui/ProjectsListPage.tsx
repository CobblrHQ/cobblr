// Projects index. Status-grouped list + search + new-project form.

import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "lucide-react";
import {
  BulkActionBar,
  CustomFieldsPanel,
  Modal,
  useToast,
  useConfirm,
  usePageTitle,
  useAskCobbAboutSelection,
} from "@cobblr/platform-web";
import { useProjects } from "./context";
import type { Project } from "./api";

type SavedViewLite = {
  id: string;
  name: string;
  config?: { group_by?: string; visible_fields?: string[] };
};
type FieldDefLite = { name: string; display_label: string };

const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
  abandoned: "Abandoned",
};
const STATUS_ORDER = ["planning", "active", "blocked", "done", "abandoned"];

export function ProjectsListPage() {
  const { api, orgSlug, getToken, displayName, itemNoun, instance, entityKind } = useProjects();
  // An instance's rows must stay INSIDE the instance — the bare /projects
  // detail route filters to the default instance and 404s on instance rows
  // ("Project not found" on every Designs/Outfits click).
  const basePath = instance ? `/instances/${instance}` : "/projects";
  // Instance skin: an "Outfits" instance reads "Outfits" / "New outfit", not
  // "projects" / "New project". Falls back to the plain module wording.
  const heading = displayName ?? "projects";
  const noun = itemNoun ?? "project";
  const nounPlural = `${noun}s`;
  usePageTitle(displayName ?? "Projects");
  const qc = useQueryClient();
  // entityKind (`<instance>:item`, or `projects:project` for the default) MUST
  // be in the key — the API is instance-scoped, so without it sibling projects
  // instances (e.g. Designs) collide on one cache entry and show each other's
  // items. Same class of bug as the inventory parts list.
  const list = useQuery({ queryKey: ["projects-list", entityKind], queryFn: () => api.listProjects() });
  const [name, setName] = useState("");
  // Create modal: name + the instance's custom fields (e.g. a Design's pattern
  // link + category) promoted into creation — so "New design" can capture the
  // PATTERN, not just a name (a713 / f65ba15b: "cannot add patterns to Designs").
  const [creating, setCreating] = useState(false);
  const [newMeta, setNewMeta] = useState<Record<string, unknown>>({});
  const [query, setQuery] = useState("");
  const toast = useToast();
  const confirm = useConfirm();

  // Saved views for projects:project — the Yarn "Designs" feature ships one
  // pinned. `?view=<id>` renders the list AS that view (its group_by groups,
  // visible_fields pick the columns); a chip bar switches (and "All projects"
  // returns to the native status-grouped list). The projects api has no views
  // client, so hit the platform endpoints directly with the same Bearer.
  const [params, setParams] = useSearchParams();
  const viewId = params.get("view");
  const savedViews = useQuery({
    queryKey: ["proj-saved-views", orgSlug, entityKind],
    queryFn: async (): Promise<{ items: SavedViewLite[] }> => {
      const token = getToken();
      const res = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/core-views/views?kind=${encodeURIComponent(entityKind)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      return res.ok ? res.json() : { items: [] };
    },
    staleTime: 60_000,
  });
  const projFieldDefs = useQuery({
    queryKey: ["proj-field-defs", orgSlug, entityKind],
    queryFn: async (): Promise<{ items: FieldDefLite[] }> => {
      const token = getToken();
      const res = await fetch(
        `/api/v1/orgs/${orgSlug}/field-defs?kind=${encodeURIComponent(entityKind)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      return res.ok ? res.json() : { items: [] };
    },
    staleTime: 60_000,
  });
  const views = savedViews.data?.items ?? [];
  const activeView = viewId ? views.find((v) => v.id === viewId) ?? null : null;
  const groupByField = activeView?.config?.group_by;
  const viewFields = activeView?.config?.visible_fields;
  function selectView(id: string | null) {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set("view", id);
        else n.delete("view");
        return n;
      },
      { replace: true },
    );
  }

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        metadata: Object.keys(newMeta).length ? newMeta : undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects-list"] });
      setName("");
      setNewMeta({});
      setCreating(false);
    },
    onError: (e) => toast.error((e as Error).message),
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


  // What is ticked IS context: with the panel open, "delete these" means the

  // ones on screen a person pointed at, and Cobb gets their ids rather than a

  // count he has to go and re-find.

  const askCobb = useAskCobbAboutSelection(selected, items, "projects:project", "project");
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
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">{heading}</h1>
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

      <div className="flex">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <Plus size={14} /> New {noun}
        </button>
      </div>

      {/* Create modal — name + the instance's custom fields (a Design's pattern
          link + category) so you capture the pattern at creation, not just a
          name. Mirrors inventory's "New yarn" field-promoting create. */}
      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setName("");
          setNewMeta({});
        }}
        title={`New ${noun}`}
        size="md"
      >
        <form onSubmit={submit} className="space-y-4 p-1">
          <div>
            <label className="block text-xs font-medium text-muted dark:text-slate-400 mb-1">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${noun} name…`}
              className="input w-full"
            />
          </div>
          {/* The instance's custom fields (Designs: pattern link + category).
              Keyed off the INSTANCE kind (designs:item) — using projects:project
              would fetch the base kind's defs and show none of them. */}
          <CustomFieldsPanel
            entityKind={entityKind}
            values={newMeta}
            onCommit={(field, value) => setNewMeta((m) => ({ ...m, [field]: value }))}
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
                setNewMeta({});
              }}
              className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800/70 text-sm font-medium px-3 py-2 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending || !name.trim()}
              className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
            >
              <Plus size={14} /> {create.isPending ? "Creating…" : `Create ${noun}`}
            </button>
          </div>
        </form>
      </Modal>

      {/* Saved-view chips — bundles (Yarn → Designs) ship pinned ones. */}
      {views.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <ProjViewChip active={!activeView} onClick={() => selectView(null)}>
            All {nounPlural}
          </ProjViewChip>
          {views.map((v) => (
            <ProjViewChip key={v.id} active={activeView?.id === v.id} onClick={() => selectView(v.id)}>
              {v.name}
            </ProjViewChip>
          ))}
        </div>
      )}

      {items.length === 0 && !list.isLoading && (
        <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-12 text-center text-faint dark:text-slate-500">
          No {nounPlural} yet - create one above.
        </div>
      )}
      {items.length > 0 && filtered.length === 0 && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No {nounPlural} match "{query}".
        </div>
      )}

      {activeView && filtered.length > 0 && (
        <ProjectsViewTable
          rows={filtered}
          groupBy={groupByField}
          fields={viewFields}
          fieldDefs={projFieldDefs.data?.items ?? []}
        />
      )}

      {!activeView && STATUS_ORDER.map((s) => {
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
                    to={`${basePath}/${p.id}`}
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
        onAskCobb={askCobb}
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

function ProjViewChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-xs font-medium px-3 py-1 rounded-full border transition " +
        (active
          ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-950/30 text-accent"
          : "border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:border-cobble-300 dark:hover:border-cobble-700")
      }
    >
      {children}
    </button>
  );
}

function projCellValue(p: Project, field: string): string {
  if (field === "title" || field === "name") return p.name;
  if (field === "status") return p.status;
  if (field === "priority") return p.priority ?? "";
  if (field === "target_date") return p.target_date ?? "";
  const v = (p.metadata as Record<string, unknown> | null)?.[field];
  return v == null ? "" : String(v);
}

function projGroup(rows: Project[], groupBy?: string): { key: string; rows: Project[] }[] {
  if (!groupBy) return [{ key: "", rows }];
  const map = new Map<string, Project[]>();
  for (const p of rows) {
    const k = projCellValue(p, groupBy).trim() || "—";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(p);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, r]) => ({ key: k, rows: r }));
}

function projHumanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Renders the projects list AS a saved view: grouped by the view's group_by,
 *  columns from its visible_fields. Used when `?view=<id>` is set. */
function ProjectsViewTable({
  rows,
  groupBy,
  fields,
  fieldDefs,
}: {
  rows: Project[];
  groupBy?: string;
  fields?: string[];
  fieldDefs: FieldDefLite[];
}) {
  const { instance } = useProjects();
  const basePath = instance ? `/instances/${instance}` : "/projects";
  const cols = (fields && fields.length ? fields : ["title", "status"]).filter(
    (f) => f !== "title" && f !== "name",
  );
  const label = (f: string) =>
    ({ status: "Status", priority: "Priority", target_date: "Target" } as Record<string, string>)[f] ??
    fieldDefs.find((d) => d.name === f)?.display_label ??
    projHumanize(f);
  return (
    <div className="space-y-4">
      {projGroup(rows, groupBy).map((g) => (
        <section key={g.key} className="space-y-2">
          {groupBy && (
            <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">
              // {g.key} <span className="text-faint dark:text-slate-500">({g.rows.length})</span>
            </h3>
          )}
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  {cols.map((c) => (
                    <th key={c} className="text-left px-3 py-2">{label(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-slate-700">
                {g.rows.map((p) => (
                  <tr key={p.id} className="hover:bg-subtle dark:hover:bg-slate-800/40 transition">
                    <td className="px-3 py-2">
                      <Link to={`${basePath}/${p.id}`} className="font-medium text-content dark:text-mortar-100 hover:text-accent">
                        {p.name}
                      </Link>
                    </td>
                    {cols.map((c) => {
                      const raw = projCellValue(p, c);
                      const isUrl = /^https?:\/\//.test(raw);
                      return (
                        <td key={c} className="px-3 py-2 text-muted dark:text-slate-400 text-xs">
                          {raw ? (
                            isUrl ? (
                              <a href={raw} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                                link
                              </a>
                            ) : (
                              raw
                            )
                          ) : (
                            "—"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
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
