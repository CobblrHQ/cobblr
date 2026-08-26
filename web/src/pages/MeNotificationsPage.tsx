// /me/notifications — full inbox view across every workspace.
//
// The header bell is the quick-look popover (10 most recent). This
// page is the "actually read what I missed" surface: filter by
// workspace, by read/unread, click into the linked page in the
// right workspace.

import { useState } from "react";
import { AreaTabs, NOTIFICATION_TABS } from "../components/AreaTabs";
import { Link, useNavigate } from "react-router-dom";
import { notificationAction } from "../lib/notification-action";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { QueryError } from "../components/QueryError";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, type CrossOrgNotificationEntry } from "../lib/api";
import { useToast, usePageTitle } from "@cobblr/platform-web";

export function MeNotificationsPage() {
  usePageTitle("Notifications");
  const { orgs } = useAuth();
  const { activeSlug, setActiveSlug } = useActiveOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  // Default to THIS workspace, not the cross-workspace firehose — seeing
  // workspace A's notifications while you're in B is noise. The dropdown
  // still offers "all workspaces" for the deliberate global view.
  const [orgFilter, setOrgFilter] = useState<string>(activeSlug);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const q = useQuery({
    queryKey: ["me-notifications-full", unreadOnly],
    queryFn: () => api.meNotifications(100),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.meMarkNotificationRead(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me-notifications-full"] });
      void qc.invalidateQueries({ queryKey: ["me-notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["me-notifications-list"] });
    },
  });
  const markAll = useMutation({
    mutationFn: () => api.meMarkAllNotificationsRead(),
    onSuccess: ({ count }) => {
      toast.success(`Marked ${count} read`);
      void qc.invalidateQueries({ queryKey: ["me-notifications-full"] });
      void qc.invalidateQueries({ queryKey: ["me-notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["me-notifications-list"] });
    },
  });

  let items = q.data?.items ?? [];
  if (orgFilter) items = items.filter((n) => n.org_slug === orgFilter);
  if (unreadOnly) items = items.filter((n) => !n.read_at);

  function open(n: CrossOrgNotificationEntry) {
    if (!n.read_at) markRead.mutate(n.id);
    // Same as the bell: the switch is a full document load, so it has to carry
    // the destination rather than being followed by a navigate that cannot run.
    // Never hand a stored link straight to navigate(): it may be absolute, or
    // carry its own /w/<slug>, and both resolve to nothing under the router's
    // workspace basename.
    // The same decision the bell makes, so one row cannot behave two ways.
    const act = notificationAction(n);
    if (!act.goesSomewhere) return;
    if (act.switchTo && setActiveSlug(act.switchTo, act.path)) return;
    if (act.path) navigate(act.path);
    else if (act.external) window.open(act.external, "_blank", "noopener");
  }

  // Group by day for readable scanning.
  const byDay = new Map<string, CrossOrgNotificationEntry[]>();
  for (const n of items) {
    const day = new Date(n.created_at).toLocaleDateString();
    const arr = byDay.get(day) ?? [];
    arr.push(n);
    byDay.set(day, arr);
  }

  return (
    <div className="space-y-4">
      <AreaTabs tabs={NOTIFICATION_TABS} area="notifications" />
      <div className="flex items-baseline gap-3 pb-1 flex-wrap">
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} {unreadOnly ? "unread" : "total"}
        </span>
        <div className="flex-1" />
        <select
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        >
          <option value="">all workspaces</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.slug}>
              {o.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
            className="accent-cobble-500"
          />
          unread only
        </label>
        <button
          onClick={() => markAll.mutate()}
          disabled={markAll.isPending}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent disabled:opacity-50"
        >
          <CheckCheck size={12} /> Mark all read
        </button>
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Every notification dispatched to you across every workspace you
        belong to. Click a row to switch to that workspace + open the
        linked page. Refreshes every 30s.
      </p>

      {q.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {q.isError && (
        <QueryError what="notifications" onRetry={() => q.refetch()} />
      )}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <div className="text-sm text-muted italic">
          {unreadOnly ? "No unread notifications." : "No notifications yet."}
        </div>
      )}

      {Array.from(byDay.entries()).map(([day, entries]) => (
        <section key={day}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
            {day}{" "}
            <span className="text-faint dark:text-slate-500">
              ({entries.length})
            </span>
          </div>
          <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800">
            {entries.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => open(n)}
                  className={
                    "w-full text-left px-4 py-3 transition flex items-baseline gap-3 " +
                    (n.read_at
                      ? "opacity-60 hover:bg-subtle/50 dark:hover:bg-slate-800/40"
                      : "hover:bg-subtle dark:hover:bg-slate-800/60")
                  }
                >
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300 shrink-0">
                    {n.org_name}
                  </span>
                  <div className="flex-1 min-w-0">
                    {/* Wrap to a couple of lines — a single truncated line cut
                        the key phrase off on mobile (the org badge squeezes the
                        row), so "Alex offered to share their…" lost its point. */}
                    <div className="text-sm text-content dark:text-mortar-100 line-clamp-2">
                      {n.message}
                    </div>
                    {n.card?.body && (
                      <div className="mt-0.5 border-l-2 border-line dark:border-slate-700 pl-2 text-xs text-muted dark:text-slate-400 line-clamp-2 break-words">
                        {n.card.body}
                      </div>
                    )}
                    <div className="text-[11px] font-mono text-faint dark:text-slate-500 mt-0.5">
                      {n.event_type} · {new Date(n.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                  {n.read_at && (
                    <Check size={12} className="text-faint shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Link
        to="/me/activity"
        className="inline-flex text-sm text-accent hover:text-accent"
      >
        See your activity feed →
      </Link>
    </div>
  );
}
