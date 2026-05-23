// /me/activity — cross-workspace activity feed for the logged-in
// user. Backed by /me/activity which joins through org_memberships
// so removed-from-workspace users naturally stop seeing those rows.
//
// Filter: optional ?org=<slug> narrows to one workspace.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { History } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api, type CrossOrgActivityEntry } from "../lib/api";

export function MeActivityPage() {
  const { orgs } = useAuth();
  const [params, setParams] = useSearchParams();
  const orgFilter = params.get("org") ?? undefined;

  const q = useQuery({
    queryKey: ["me-activity", orgFilter ?? "_all"],
    queryFn: () => api.meActivity({ limit: 100, org: orgFilter }),
  });

  const items = q.data?.items ?? [];

  // Group by day for readable scanning.
  const byDay = useMemo(() => {
    const groups = new Map<string, CrossOrgActivityEntry[]>();
    for (const e of items) {
      const day = new Date(e.occurred_at).toLocaleDateString();
      const arr = groups.get(day) ?? [];
      arr.push(e);
      groups.set(day, arr);
    }
    return Array.from(groups.entries());
  }, [items]);

  function setOrgFilter(slug: string | null) {
    if (slug) params.set("org", slug);
    else params.delete("org");
    setParams(params, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <History size={20} className="text-cobble-600" />
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Your activity
        </h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {items.length} actions
        </span>
        <div className="flex-1" />
        <select
          value={orgFilter ?? ""}
          onChange={(e) => setOrgFilter(e.target.value || null)}
          className="px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        >
          <option value="">all workspaces</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.slug}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Every action attributed to you across every workspace you belong
        to. Filter to a single workspace via the picker, or open the
        per-workspace activity log under <code className="font-mono text-xs">/configuration → Activity log</code>.
      </p>

      {q.isLoading && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {!q.isLoading && items.length === 0 && (
        <div className="text-sm text-slate-500 italic">
          {orgFilter
            ? "No activity in this workspace yet."
            : "No activity yet."}
        </div>
      )}

      {byDay.map(([day, entries]) => (
        <section key={day}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            {day} <span className="text-slate-400 dark:text-slate-500">({entries.length})</span>
          </div>
          <ul className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
            {entries.map((e) => (
              <ActivityRow key={e.id} entry={e} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ActivityRow({ entry: e }: { entry: CrossOrgActivityEntry }) {
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  const title =
    typeof diff.name === "string"
      ? diff.name
      : typeof diff.title === "string"
        ? diff.title
        : null;
  const action = humanAction(e.action);
  return (
    <li className="px-4 py-2 flex items-baseline gap-3 text-sm">
      <Link
        to={`/me/activity?org=${e.org_slug}`}
        className="text-[10px] font-mono uppercase tracking-wider text-cobble-700 bg-cobble-50 dark:text-cobble-300 dark:bg-cobble-900/30 px-1.5 py-0.5 rounded hover:bg-cobble-100"
      >
        {e.org_name}
      </Link>
      <span className="text-slate-600 dark:text-mortar-200">{action}</span>
      <span className="text-slate-700 dark:text-mortar-100 truncate">
        {title ?? (
          <span className="font-mono text-xs text-slate-400">
            {e.entity_type ?? e.action}
          </span>
        )}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-slate-400 shrink-0">
        {new Date(e.occurred_at).toLocaleTimeString()}
      </span>
    </li>
  );
}

function humanAction(a: string): string {
  const map: Record<string, string> = {
    created: "created",
    updated: "updated",
    deleted: "deleted",
    login: "signed in",
    user_created: "joined",
    pairing_created: "linked",
    pairing_deleted: "unlinked",
  };
  if (map[a]) return map[a];
  if (a.endsWith("_created")) return "created";
  if (a.endsWith("_updated")) return "updated";
  if (a.endsWith("_deleted")) return "deleted";
  return a.replace(/_/g, " ");
}
