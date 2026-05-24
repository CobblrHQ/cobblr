// /me/notifications — full inbox view across every workspace.
//
// The header bell is the quick-look popover (10 most recent). This
// page is the "actually read what I missed" surface: filter by
// workspace, by read/unread, click into the linked page in the
// right workspace.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CheckCheck } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, type CrossOrgNotificationEntry } from "../lib/api";
import { useToast } from "@cobblr/platform-web";

export function MeNotificationsPage() {
  const { orgs } = useAuth();
  const { setActiveSlug } = useActiveOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [orgFilter, setOrgFilter] = useState<string>("");
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
    setActiveSlug(n.org_slug);
    if (n.link_url) navigate(n.link_url);
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
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3 flex-wrap">
        <Bell size={20} className="text-cobble-600" />
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Notifications
        </h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {items.length} {unreadOnly ? "unread" : "total"}
        </span>
        <div className="flex-1" />
        <select
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          className="px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        >
          <option value="">all workspaces</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.slug}>
              {o.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-mortar-200 cursor-pointer">
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
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-cobble-600 hover:text-cobble-700 disabled:opacity-50"
        >
          <CheckCheck size={12} /> Mark all read
        </button>
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Every notification dispatched to you across every workspace you
        belong to. Click a row to switch to that workspace + open the
        linked page. Refreshes every 30s.
      </p>

      {q.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {!q.isLoading && items.length === 0 && (
        <div className="text-sm text-slate-500 italic">
          {unreadOnly ? "No unread notifications." : "No notifications yet."}
        </div>
      )}

      {Array.from(byDay.entries()).map(([day, entries]) => (
        <section key={day}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            {day}{" "}
            <span className="text-slate-400 dark:text-slate-500">
              ({entries.length})
            </span>
          </div>
          <ul className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
            {entries.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => open(n)}
                  className={
                    "w-full text-left px-4 py-3 transition flex items-baseline gap-3 " +
                    (n.read_at
                      ? "opacity-60 hover:bg-mortar-50/50 dark:hover:bg-slate-800/40"
                      : "hover:bg-mortar-50 dark:hover:bg-slate-800/60")
                  }
                >
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-50 dark:bg-cobble-900/30 text-cobble-700 dark:text-cobble-300 shrink-0">
                    {n.org_name}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-700 dark:text-mortar-100 truncate">
                      {n.message}
                    </div>
                    <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 mt-0.5">
                      {n.event_type} · {new Date(n.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                  {n.read_at && (
                    <Check size={12} className="text-slate-300 shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Link
        to="/me/activity"
        className="inline-flex text-sm text-cobble-600 hover:text-cobble-700"
      >
        See your activity feed →
      </Link>
    </div>
  );
}
