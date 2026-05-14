// Phase 0 dashboard: greet the user, list their orgs, show each
// org's tenant-DB platform_local state (proves the per-tenant DB
// + middleware chain is wired correctly), and a "no modules yet"
// placeholder. Module loading hooks in here in milestone 4.

import { useQuery } from "@tanstack/react-query";
import { Boxes, Database, History, LogOut } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { CobblestoneMark } from "../CobblestoneMark";
import {
  api,
  type ActivityEntry,
  type ModuleListItem,
  type OrgLocalResponse,
  type OrgMembership,
} from "../lib/api";

export function Dashboard() {
  const { user, orgs, logout } = useAuth();
  const { data: health } = useQuery({
    queryKey: ["healthz"],
    queryFn: () => api.healthz(),
    refetchInterval: 30_000,
  });
  const { data: modules } = useQuery({
    queryKey: ["modules"],
    queryFn: () => api.modules(),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center gap-3">
          <CobblestoneMark size={28} />
          <span className="font-display font-extrabold text-slate-700 lowercase">
            cobblr
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            {health?.env}
          </span>
          <div className="flex-1" />
          <span className="text-xs text-slate-500">{user?.display_name}</span>
          <button
            onClick={logout}
            className="text-slate-400 hover:text-ember-500 transition p-1.5"
            title="Sign out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-5 py-8 space-y-6">
        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            // workspaces
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {orgs.map((o) => (
              <WorkspaceCard key={o.id} org={o} />
            ))}
          </div>
        </section>

        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            // modules
          </div>
          <ModulesPanel items={modules?.items ?? []} />
        </section>

        {orgs[0] && (
          <section>
            <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2 flex items-center gap-1.5">
              <History size={11} /> recent activity
            </div>
            <ActivityPanel slug={orgs[0].slug} />
          </section>
        )}
      </main>
    </div>
  );
}

function ModulesPanel({ items }: { items: ModuleListItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white/50 p-10 text-center">
        <Boxes size={28} className="mx-auto mb-3 text-slate-300" />
        <div className="text-sm text-slate-500">No modules installed yet.</div>
        <div className="mt-1 text-[11px] font-mono text-slate-400">
          first-party modules drop in here when phase 1 lands.
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((m) => (
        <div key={m.name} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="font-display font-bold text-slate-700">{m.displayName}</div>
          <div className="text-[11px] font-mono text-slate-400">
            {m.name} · v{m.version}
          </div>
          <div className="mt-2 text-sm text-slate-600">{m.description}</div>
        </div>
      ))}
    </div>
  );
}

function ActivityPanel({ slug }: { slug: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["org-activity", slug],
    queryFn: () => api.orgActivity(slug, 10),
    staleTime: 30_000,
  });
  if (isLoading) return <div className="text-[11px] text-slate-400">loading…</div>;
  if (error) {
    return <div className="text-[11px] text-ember-500">{(error as Error).message}</div>;
  }
  if (!data || data.items.length === 0) {
    return (
      <div className="text-[11px] text-slate-400">No activity yet.</div>
    );
  }
  return (
    <ul className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
      {data.items.map((e: ActivityEntry) => (
        <li key={e.id} className="px-4 py-2 flex items-baseline gap-3 text-[12px]">
          <span className="font-mono text-cobble-500 shrink-0 w-32 truncate">{e.action}</span>
          <span className="text-slate-500 truncate">{e.entity_type}</span>
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-slate-400 shrink-0">
            {new Date(e.occurred_at).toLocaleTimeString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorkspaceCard({ org }: { org: OrgMembership }) {
  // Fetch each workspace's platform_local once per mount. Live values
  // aren't expected to change in Phase 0; refetch on focus only.
  const { data, error, isLoading } = useQuery<OrgLocalResponse>({
    queryKey: ["org-local", org.slug],
    queryFn: () => api.orgLocal(org.slug),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className="w-2 h-10 rounded-sm shrink-0"
          style={{ background: "#8B7355" }}
        />
        <div className="flex-1 min-w-0">
          <div className="font-display font-bold text-slate-700 truncate">
            {org.name}
          </div>
          <div className="text-[11px] font-mono text-slate-400 truncate">
            {org.slug} · {org.role}
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-2">
          <Database size={11} /> tenant db
        </div>
        {isLoading && <div className="text-[11px] text-slate-400">loading…</div>}
        {error && (
          <div className="text-[11px] text-ember-500 break-words">
            {(error as Error).message}
          </div>
        )}
        {data && (
          <dl className="space-y-0.5 text-[11px] font-mono">
            {data.rows.map((r) => (
              <div key={r.key} className="flex items-baseline gap-2">
                <dt className="text-slate-400 shrink-0">{r.key}</dt>
                <dd className="text-slate-600 truncate min-w-0">
                  {formatValue(r.value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
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
