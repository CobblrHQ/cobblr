// Dashboard — landing page once authed. Lists workspaces, shows
// each tenant DB's platform_local state (proves per-tenant DB
// isolation visually), surfaces installed modules + recent activity.
// The chrome (header + nav) lives in AppLayout.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Boxes, Database, History, ListChecks } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import {
  api,
  type ActivityEntry,
  type ModuleListItem,
  type OrgLocalResponse,
  type OrgMembership,
} from "../lib/api";

export function Dashboard() {
  const { orgs } = useAuth();
  const { activeOrg } = useActiveOrg();
  const modules = useQuery({
    queryKey: ["modules"],
    queryFn: () => api.modules(),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="space-y-6">
      {/* Active workspace card — the dashboard belongs to whichever
          workspace you're currently in. The rest of the user's
          workspaces are reachable via the header switcher. */}
      {activeOrg && (
        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            // active workspace
          </div>
          <WorkspaceCard org={activeOrg} />
        </section>
      )}

      <section>
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
          // modules
        </div>
        <ModulesPanel items={modules.data?.items ?? []} />
      </section>

      {activeOrg && <SnapshotPanel slug={activeOrg.slug} />}

      {activeOrg && (
        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2 flex items-center gap-1.5">
            <History size={11} /> recent activity
          </div>
          <ActivityPanel slug={activeOrg.slug} />
        </section>
      )}

      {orgs.length > 1 && (
        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            // other workspaces ({orgs.length - 1})
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            You belong to {orgs.length} workspaces. Switch from the header
            chip at the top-left.
          </div>
        </section>
      )}
    </div>
  );
}

interface PartListItem {
  id: string;
  name: string;
  qty: number;
  min_qty: number | null;
  low_stock: boolean;
}
interface TaskListItem {
  id: string;
  project_id: string;
  title: string;
  status: string;
  blocked_deps?: number;
}

function SnapshotPanel({ slug }: { slug: string }) {
  // Two cheap reads — low-stock parts and tasks blocked by deps.
  // Both are computed at SELECT time, so they're already O(1) views.
  const lowStock = useQuery<{ items: PartListItem[] }>({
    queryKey: ["snapshot-low-stock", slug],
    queryFn: () =>
      api.request<{ items: PartListItem[] }>(
        "GET",
        `/orgs/${slug}/modules/inventory/parts?low_stock=1&limit=5`,
      ),
    staleTime: 30_000,
  });
  const blocked = useQuery<{ items: TaskListItem[] }>({
    queryKey: ["snapshot-blocked-tasks", slug],
    queryFn: () =>
      api.request<{ items: TaskListItem[] }>(
        "GET",
        `/orgs/${slug}/modules/projects/tasks?blocked=1&limit=5`,
      ),
    staleTime: 30_000,
  });

  const lowItems = lowStock.data?.items ?? [];
  const blockedItems = blocked.data?.items ?? [];
  if (lowItems.length === 0 && blockedItems.length === 0) return null;

  return (
    <section>
      <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
        // needs attention
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {lowItems.length > 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-ember-500 mb-2">
              <AlertTriangle size={11} /> low stock ({lowItems.length})
            </div>
            <ul className="space-y-1">
              {lowItems.map((p) => (
                <li key={p.id} className="flex items-baseline gap-2 text-sm">
                  <Link
                    to={`/inventory/parts/${p.id}`}
                    className="text-slate-700 dark:text-mortar-100 hover:text-cobble-600 truncate flex-1"
                  >
                    {p.name}
                  </Link>
                  <span className="font-mono text-[10px] text-slate-400">
                    {p.qty}/{p.min_qty ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {blockedItems.length > 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
              <ListChecks size={11} /> blocked tasks ({blockedItems.length})
            </div>
            <ul className="space-y-1">
              {blockedItems.map((t) => (
                <li key={t.id} className="flex items-baseline gap-2 text-sm">
                  <Link
                    to={`/projects/${t.project_id}`}
                    className="text-slate-700 dark:text-mortar-100 hover:text-cobble-600 truncate flex-1"
                  >
                    {t.title}
                  </Link>
                  <span className="font-mono text-[10px] text-ember-500">
                    {t.blocked_deps ?? 0}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function WorkspaceCard({ org }: { org: OrgMembership }) {
  const { data, error, isLoading } = useQuery<OrgLocalResponse>({
    queryKey: ["org-local", org.slug],
    queryFn: () => api.orgLocal(org.slug),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="w-2 h-10 rounded-sm shrink-0" style={{ background: "#8B7355" }} />
        <div className="flex-1 min-w-0">
          <div className="font-display font-bold text-slate-700 dark:text-mortar-100 truncate">{org.name}</div>
          <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">
            {org.slug} · {org.role}
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 dark:border-slate-700 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">
          <Database size={11} /> tenant db
        </div>
        {isLoading && <div className="text-[11px] text-slate-400 dark:text-slate-500">loading…</div>}
        {error && (
          <div className="text-[11px] text-ember-500 break-words">{(error as Error).message}</div>
        )}
        {data && (
          <dl className="space-y-0.5 text-[11px] font-mono">
            {data.rows.map((r) => (
              <div key={r.key} className="flex items-baseline gap-2">
                <dt className="text-slate-400 dark:text-slate-500 shrink-0">{r.key}</dt>
                <dd className="text-slate-600 dark:text-mortar-200 truncate min-w-0">{formatValue(r.value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

function ModulesPanel({ items }: { items: ModuleListItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/50 p-10 text-center">
        <Boxes size={28} className="mx-auto mb-3 text-slate-300 dark:text-slate-600" />
        <div className="text-sm text-slate-500 dark:text-slate-400">No modules installed yet.</div>
      </div>
    );
  }
  // A specialisation module (3d-printers, workshop-mods, …) has no
  // route of its own — it extends a base module's entity kind named
  // by its first dependency. Nest each specialisation inside its
  // base module's card so the hierarchy is visible, and route the
  // nested card to the base page with the specialisation as a lens.
  const names = new Set(items.map((m) => m.name));
  const childrenByParent = new Map<string, ModuleListItem[]>();
  const tops: ModuleListItem[] = [];
  for (const m of items) {
    const parent = m.dependencies.find((d) => names.has(d));
    if (parent) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(m);
      childrenByParent.set(parent, arr);
    } else {
      tops.push(m);
    }
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 items-start">
      {tops.map((m) => (
        <ModuleCard key={m.name} module={m} specialisations={childrenByParent.get(m.name) ?? []} />
      ))}
    </div>
  );
}

function ModuleCard({
  module: m,
  specialisations,
}: {
  module: ModuleListItem;
  specialisations: ModuleListItem[];
}) {
  // Leaf module — the whole card is one link.
  if (specialisations.length === 0) {
    return (
      <Link
        to={`/${m.name}`}
        className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 hover:border-cobble-300 transition block min-h-[150px]"
      >
        <div className="flex items-baseline gap-2">
          <div className="font-display font-bold text-slate-700 dark:text-mortar-100">{m.displayName}</div>
          <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500">v{m.version}</div>
        </div>
        <div className="mt-1 text-sm text-slate-600 dark:text-mortar-200">{m.description}</div>
      </Link>
    );
  }
  // Base module with specialisations — keep the card compact: the
  // specialisations are a wrapped row of chips, not full sub-cards
  // (those balloon the card and wreck the grid). Each chip's full
  // description is available on hover.
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex flex-col min-h-[150px]">
      <Link to={`/${m.name}`} className="block group">
        <div className="flex items-baseline gap-2">
          <div className="font-display font-bold text-slate-700 dark:text-mortar-100 group-hover:text-cobble-600 transition">
            {m.displayName}
          </div>
          <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500">v{m.version}</div>
        </div>
        <div className="mt-1 text-sm text-slate-600 dark:text-mortar-200">{m.description}</div>
      </Link>
      <div className="mt-auto pt-3 border-t border-slate-100 dark:border-slate-700 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mr-0.5">
          specialisations
        </span>
        {specialisations.map((s) => (
          <Link
            key={s.name}
            to={`/${m.name}?lens=${s.name}`}
            title={s.description}
            className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 bg-mortar-50/60 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-mortar-200 hover:border-cobble-300 hover:text-cobble-600 dark:hover:text-cobble-300 transition"
          >
            {s.displayName}
          </Link>
        ))}
      </div>
    </div>
  );
}

function ActivityPanel({ slug }: { slug: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["org-activity", slug],
    queryFn: () => api.orgActivity(slug, 10),
    staleTime: 30_000,
  });
  if (isLoading) return <div className="text-[11px] text-slate-400 dark:text-slate-500">loading…</div>;
  if (error) return <div className="text-[11px] text-ember-500">{(error as Error).message}</div>;
  if (!data || data.items.length === 0) {
    return <div className="text-[11px] text-slate-400 dark:text-slate-500">No activity yet.</div>;
  }
  return (
    <ul className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-700">
      {data.items.map((e: ActivityEntry) => (
        <li key={e.id} className="px-4 py-2 flex items-baseline gap-3 text-[12px]">
          <span className="font-mono text-cobble-500 shrink-0 w-32 truncate">{e.action}</span>
          <span className="text-slate-500 dark:text-slate-400 truncate">{e.entity_type}</span>
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 shrink-0">
            {new Date(e.occurred_at).toLocaleTimeString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
