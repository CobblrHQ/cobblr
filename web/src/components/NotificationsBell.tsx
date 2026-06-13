// Bell icon in the header — badge with unread count, click opens
// a popover list. Cross-workspace inbox: every notification for
// the user is visible regardless of which workspace they're
// currently viewing. Each row shows the workspace name and
// clicking switches the active workspace + navigates to link_url
// so accept/revoke flows still land on the right page.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, type CrossOrgNotificationEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { activeSlug, setActiveSlug } = useActiveOrg();

  const unread = useQuery({
    queryKey: ["me-notifications-unread"],
    queryFn: () => api.meNotificationsUnreadCount(),
    refetchInterval: 15_000,
  });
  // Unread in the CURRENT workspace, so the badge can distinguish "you
  // have something here" (ember red) from "the count is all in another
  // workspace" (sky blue — cool vs warm so they're distinct at a glance)
  // — a workspace-A alert shouldn't read as urgent while you're in B.
  const unreadHere = useQuery({
    queryKey: ["notifications-unread", activeSlug],
    queryFn: () => api.notificationsUnreadCount(activeSlug),
    enabled: !!activeSlug,
    refetchInterval: 15_000,
  });
  const list = useQuery({
    queryKey: ["me-notifications-list"],
    queryFn: () => api.meNotifications(),
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.meMarkNotificationRead(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me-notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["me-notifications-list"] });
    },
  });
  const markAll = useMutation({
    mutationFn: () => api.meMarkAllNotificationsRead(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me-notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["me-notifications-list"] });
    },
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const count = unread.data?.count ?? 0;
  const here = unreadHere.data?.count ?? 0;
  // Every unread is in OTHER workspaces → sky blue (heads-up, not here).
  const otherOnly = count > 0 && here === 0;
  const other = Math.max(0, count - here);

  function handleItemClick(n: CrossOrgNotificationEntry) {
    if (!n.read_at) markRead.mutate(n.id);
    // A workspace-invite is about ANOTHER workspace you're not in yet — it's
    // scoped to one of your own only so it surfaces. Don't switch to that scope
    // workspace; just open the accept link.
    if (n.event_type !== "workspace.invited") setActiveSlug(n.org_slug);
    if (n.link_url) navigate(n.link_url);
    setOpen(false);
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-100 transition p-1.5 relative"
        title={
          count === 0
            ? "Notifications"
            : otherOnly
              ? `${count} unread notification${count === 1 ? "" : "s"} in other workspaces`
              : other > 0
                ? `${here} unread here · ${other} in other workspaces`
                : `${here} unread notification${here === 1 ? "" : "s"}`
        }
      >
        {/* Always a normal bell — a struck-through (BellOff) icon reads
            as "notifications muted", which is wrong; zero unread is just
            an empty badge, not a disabled state. */}
        <Bell size={14} />
        {count > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-1 leading-none ${
              otherOnly
                ? "bg-sky-600 text-white"
                : "bg-ember-500 text-mortar-50"
            }`}
            aria-label={
              otherOnly
                ? `${count} unread in other workspaces`
                : `${count} unread`
            }
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-9 w-80 max-h-96 overflow-y-auto rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line dark:border-slate-700">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
              notifications
            </div>
            {count > 0 && (
              <button
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="text-[10px] font-mono text-accent hover:text-accent transition"
              >
                mark all read
              </button>
            )}
          </div>
          {list.isLoading && (
            <div className="px-3 py-4 text-[11px] text-faint">loading…</div>
          )}
          {list.data && list.data.items.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-faint italic">
              No notifications yet.
            </div>
          )}
          <ul>
            {list.data && list.data.items.length === 0 && (
              <li className="px-3 py-4 text-[11px] text-faint italic">
                Nothing yet.
              </li>
            )}
            {list.data?.items.map((n) => (
              <li
                key={n.id}
                className={
                  "group flex items-stretch border-b border-line dark:border-slate-700 last:border-0 transition " +
                  (n.read_at
                    ? "opacity-60 hover:bg-subtle/50 dark:hover:bg-slate-800/50"
                    : "hover:bg-subtle dark:hover:bg-slate-800")
                }
              >
                {/* Body click = open it (navigate + mark read). */}
                <button onClick={() => handleItemClick(n)} className="flex-1 min-w-0 text-left px-3 py-2">
                  <div className="text-sm text-content dark:text-mortar-100">{n.message}</div>
                  {/* flex-wrap so the timestamp wraps instead of clipping "PM". */}
                  <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
                    <span className="px-1 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300">
                      {n.event_type === "workspace.invited" ? "invite" : n.org_name}
                    </span>
                    <span>·</span>
                    <span>{new Date(n.created_at).toLocaleString()}</span>
                  </div>
                </button>
                {/* Explicit dismiss — mark read WITHOUT navigating, so clicking a
                    notification (go) vs dismissing the count is no longer ambiguous. */}
                {!n.read_at && (
                  <button
                    onClick={() => markRead.mutate(n.id)}
                    disabled={markRead.isPending}
                    title="Dismiss"
                    aria-label="Dismiss notification"
                    className="shrink-0 px-2 text-faint hover:text-accent dark:text-slate-500 dark:hover:text-cobble-300 transition"
                  >
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <Link
            to="/me/notifications"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 border-t border-line dark:border-slate-700 text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent transition text-center"
          >
            see all →
          </Link>
        </div>
      )}
    </div>
  );
}
