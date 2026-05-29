// Bell icon in the header — badge with unread count, click opens
// a popover list. Cross-workspace inbox: every notification for
// the user is visible regardless of which workspace they're
// currently viewing. Each row shows the workspace name and
// clicking switches the active workspace + navigates to link_url
// so accept/revoke flows still land on the right page.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, type CrossOrgNotificationEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { setActiveSlug } = useActiveOrg();

  const unread = useQuery({
    queryKey: ["me-notifications-unread"],
    queryFn: () => api.meNotificationsUnreadCount(),
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

  function handleItemClick(n: CrossOrgNotificationEntry) {
    if (!n.read_at) markRead.mutate(n.id);
    // Switch the active workspace to the notification's org BEFORE
    // navigating, so /configuration/links etc. show the right
    // workspace's data when the page mounts.
    setActiveSlug(n.org_slug);
    if (n.link_url) navigate(n.link_url);
    setOpen(false);
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-mortar-100 transition p-1.5 relative"
        title={
          count > 0
            ? `${count} unread notification${count === 1 ? "" : "s"}`
            : "Notifications"
        }
      >
        {/* Always a normal bell — a struck-through (BellOff) icon reads
            as "notifications muted", which is wrong; zero unread is just
            an empty badge, not a disabled state. */}
        <Bell size={14} />
        {count > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 bg-ember-500 text-mortar-50 text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-1 leading-none"
            aria-label={`${count} unread`}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-9 w-80 max-h-96 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-700">
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
              notifications
            </div>
            {count > 0 && (
              <button
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="text-[10px] font-mono text-cobble-600 hover:text-cobble-500 transition"
              >
                mark all read
              </button>
            )}
          </div>
          {list.isLoading && (
            <div className="px-3 py-4 text-[11px] text-slate-400">loading…</div>
          )}
          {list.data && list.data.items.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-slate-400 italic">
              No notifications yet.
            </div>
          )}
          <ul>
            {list.data && list.data.items.length === 0 && (
              <li className="px-3 py-4 text-[11px] text-slate-400 italic">
                Nothing yet.
              </li>
            )}
            {list.data?.items.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => handleItemClick(n)}
                  className={
                    "w-full text-left px-3 py-2 border-b border-slate-100 dark:border-slate-700 last:border-0 transition " +
                    (n.read_at
                      ? "opacity-60 hover:bg-mortar-50/50 dark:hover:bg-slate-800/50"
                      : "hover:bg-mortar-50 dark:hover:bg-slate-800")
                  }
                >
                  <div className="text-sm text-slate-700 dark:text-mortar-100">
                    {n.message}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-1 flex items-center gap-1.5">
                    <span className="px-1 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-cobble-700 dark:text-cobble-300">
                      {n.org_name}
                    </span>
                    <span>·</span>
                    <span>{n.event_type}</span>
                    <span>·</span>
                    <span>{new Date(n.created_at).toLocaleString()}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <Link
            to="/me/notifications"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-[11px] font-mono uppercase tracking-widest text-cobble-600 hover:text-cobble-500 transition text-center"
          >
            see all →
          </Link>
        </div>
      )}
    </div>
  );
}
