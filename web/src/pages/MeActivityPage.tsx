// /me/activity — cross-workspace activity feed for the logged-in
// user. Backed by /me/activity which joins through org_memberships
// so removed-from-workspace users naturally stop seeing those rows.
//
// Filter: optional ?org=<slug> narrows to one workspace.

import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { History } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api, type CrossOrgActivityEntry } from "../lib/api";
import { QueryError } from "../components/QueryError";
import { usePageTitle } from "@cobblr/platform-web";

export function MeActivityPage() {
  usePageTitle("My activity");
  const { orgs } = useAuth();
  const [params, setParams] = useSearchParams();
  const orgFilter = params.get("org") ?? undefined;

  // Infinite scroll + cursor pagination (docs/design-decisions/list-pagination.md)
  // — never a capped limit + items.length count (that was the "100 actions" bug).
  const q = useInfiniteQuery({
    queryKey: ["me-activity", orgFilter ?? "_all"],
    queryFn: ({ pageParam }) => api.meActivity({ limit: 50, org: orgFilter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? items.length;

  // A sentinel below the list pulls the next page as it nears the viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);

  // Group by day + workspace as CONTIGUOUS runs (chronological order kept): the
  // workspace moves up to the section header, next to the date, instead of a pill
  // repeated on every row — frees the row width and de-clutters (the author).
  const sections = useMemo(() => {
    const out: { day: string; orgSlug: string; orgName: string; entries: CrossOrgActivityEntry[] }[] = [];
    for (const e of items) {
      const day = new Date(e.occurred_at).toLocaleDateString();
      const last = out[out.length - 1];
      if (last && last.day === day && last.orgSlug === e.org_slug) last.entries.push(e);
      else out.push({ day, orgSlug: e.org_slug, orgName: e.org_name, entries: [e] });
    }
    return out;
  }, [items]);

  function setOrgFilter(slug: string | null) {
    if (slug) params.set("org", slug);
    else params.delete("org");
    setParams(params, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <History size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Your activity
        </h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length >= total ? `${total} actions` : `${items.length} of ${total} actions`}
        </span>
        <div className="flex-1" />
        <select
          value={orgFilter ?? ""}
          onChange={(e) => setOrgFilter(e.target.value || null)}
          className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        >
          <option value="">all workspaces</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.slug}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Every action attributed to you across every workspace you belong
        to. Filter to a single workspace via the picker, or open the
        per-workspace activity log under <code className="font-mono text-xs">/configuration → Activity log</code>.
      </p>

      {q.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {q.isError && (
        <QueryError what="activity" onRetry={() => q.refetch()} />
      )}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <div className="text-sm text-muted italic">
          {orgFilter
            ? "No activity in this workspace yet."
            : "No activity yet."}
        </div>
      )}

      {sections.map((s, i) => (
        <section key={`${s.day}|${s.orgSlug}|${i}`}>
          <div className="mb-2 flex items-center gap-2 flex-wrap text-[10px] font-mono uppercase tracking-widest">
            <span className="text-accent">{s.day}</span>
            <span className="text-faint dark:text-slate-600">·</span>
            <button
              type="button"
              onClick={() => setOrgFilter(s.orgSlug)}
              className="tracking-wider text-accent bg-cobble-50 dark:text-cobble-300 dark:bg-cobble-900/30 px-1.5 py-0.5 rounded hover:bg-cobble-100"
              title={`Filter to ${s.orgName}`}
            >
              {s.orgName}
            </button>
            <span className="normal-case text-faint dark:text-slate-500">({s.entries.length})</span>
          </div>
          <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800">
            {s.entries.map((e) => (
              <ActivityRow key={e.id} entry={e} />
            ))}
          </ul>
        </section>
      ))}

      {/* Infinite-scroll sentinel + tail states. */}
      <div ref={sentinelRef} aria-hidden />
      {q.isFetchingNextPage && <div className="text-sm text-muted py-2 text-center">Loading more…</div>}
      {!q.hasNextPage && !q.isLoading && items.length > 0 && (
        <div className="text-xs text-faint dark:text-slate-500 text-center py-3">
          That's everything — {total} action{total === 1 ? "" : "s"}.
        </div>
      )}
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
  // No per-row workspace pill — the workspace now lives in the section header
  // (grouped by day + workspace). Wrap, don't truncate: the entity name is the
  // point of the row ("created White Board", not "created White Bo…").
  return (
    <li className="px-4 py-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="shrink-0 text-content dark:text-mortar-200">{action}</span>
      <span className="text-content dark:text-mortar-100 break-words min-w-0">
        {title ?? (
          <span className="font-mono text-xs text-faint">
            {e.entity_type ?? e.action}
          </span>
        )}
      </span>
      <span className="font-mono text-[10px] text-faint shrink-0 ml-auto">
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
