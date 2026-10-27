// /me/notifications — full inbox view across every workspace.
//
// The header bell is the quick-look popover (10 most recent). This
// page is the "actually read what I missed" surface: filter by
// workspace, by read/unread, click into the linked page in the
// right workspace.

import { useState } from "react";
import { AreaTabs, NOTIFICATION_TABS } from "../components/AreaTabs";
import { BellPushRow } from "../components/BellPushRow";
import { Link, useNavigate } from "react-router-dom";
import { notificationAction } from "../lib/notification-action";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Mail, MailOpen, Trash2 } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { QueryError } from "../components/QueryError";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, type CrossOrgNotificationEntry } from "../lib/api";
import { NotificationActionButtons } from "../components/NotificationActionButtons";
import { Code, useStillAsking, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import { notificationKeys } from "../lib/notification-keys";
import { PUSH_QUERY_KEY } from "../lib/usePushHere";
import { repeatsMessage } from "../lib/notification-lines";

const PAGE = 50;

export function MeNotificationsPage() {
  usePageTitle("Notifications");
  const { orgs } = useAuth();
  const { activeSlug, setActiveSlug } = useActiveOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // Default to THIS workspace, not the cross-workspace firehose — seeing
  // workspace A's notifications while you're in B is noise. The dropdown
  // still offers "all workspaces" for the deliberate global view.
  const [orgFilter, setOrgFilter] = useState<string>(activeSlug);
  const [unreadOnly, setUnreadOnly] = useState(false);

  // Filtered and paged on the server: filtering one fetched page here left
  // every older unread item out of reach, and counted only what was loaded.
  const pushQ = useQuery({ queryKey: PUSH_QUERY_KEY, queryFn: () => api.mePush() });
  const q = useInfiniteQuery({
    queryKey: notificationKeys.page(unreadOnly, orgFilter),
    queryFn: ({ pageParam }) => api.meNotifications(PAGE, { before: pageParam || undefined, org: orgFilter || undefined, unread: unreadOnly }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.meMarkNotificationRead(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notificationKeys.all() });
    },
    onError: (e: unknown) => toast.error(`Couldn't mark that read: ${e instanceof Error ? e.message : String(e)}`),
  });
  const markUnread = useMutation({
    mutationFn: (id: string) => api.meMarkNotificationUnread(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.all() }),
    onError: (e: unknown) => toast.error(`Couldn't mark that unread: ${e instanceof Error ? e.message : String(e)}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.meDeleteNotification(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationKeys.all() }),
    onError: (e: unknown) => toast.error(`Couldn't delete that: ${e instanceof Error ? e.message : String(e)}`),
  });
  const clearRead = useMutation({
    mutationFn: () => api.meClearReadNotifications(),
    onSuccess: ({ count }) => {
      toast.success(count === 1 ? "Deleted 1 read notification" : `Deleted ${count} read notifications`);
      void qc.invalidateQueries({ queryKey: notificationKeys.all() });
    },
    onError: (e: unknown) => toast.error(`Couldn't clear them: ${e instanceof Error ? e.message : String(e)}`),
  });
  const markAll = useMutation({
    mutationFn: async () => {
      if (!orgFilter) return api.meMarkAllNotificationsRead();
      const { marked } = await api.markAllNotificationsRead(orgFilter);
      return { count: marked };
    },
    onSuccess: ({ count }) => {
      toast.success(`Marked ${count} read`);
      void qc.invalidateQueries({ queryKey: notificationKeys.all() });
    },
    onError: (e: unknown) => toast.error(`Couldn't mark them read: ${e instanceof Error ? e.message : String(e)}`),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

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
    if (act.documentPath) {
      window.location.assign(act.documentPath);
      return;
    }
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

  // The offer above the list comes from this device's push read, and the list
  // from its own: drawn as each came, Mark all read dropped 130 px under the
  // offer and the link under the list dropped 230 px (#7795). The page waits
  // for both and draws whole, the tabs above it standing.
  const asking = useStillAsking(pushQ, q);
  if (asking) {
    return (
      <div className="space-y-4">
        <AreaTabs tabs={NOTIFICATION_TABS} area="notifications" />
        <div className="text-xs text-faint">loading…</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AreaTabs tabs={NOTIFICATION_TABS} area="notifications" />
      {/* The phone menu's "alerts" lands here: the same offer the bell makes. */}
      <div className="-mx-2"><BellPushRow onNavigate={() => {}} /></div>
      <div className="flex items-baseline gap-3 pb-1 flex-wrap">
        <span className="text-sm text-muted dark:text-slate-400">
          {q.hasNextPage ? `The latest ${items.length}` : `${items.length}`} {unreadOnly ? "unread" : "in all"}
        </span>
        <div className="flex-1" />
        <select
          aria-label="Workspace"
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
        <button
          onClick={async () => {
            const ok = await confirm({
              title: "Delete every notification you have read?",
              message: "In every workspace. Unread ones stay. This can't be undone.",
              confirmLabel: "Delete read",
              destructive: true,
            });
            if (ok) clearRead.mutate();
          }}
          disabled={clearRead.isPending}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent disabled:opacity-50"
        >
          <Trash2 size={12} /> Clear read
        </button>
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Every notification dispatched to you across every workspace you
        belong to. Click a row to switch to that workspace + open the
        linked page. Refreshes every 30s. Read notifications are kept for
        180 days; unread ones until you read or delete them.
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
          <div className="text-[10px] uppercase tracking-widest text-accent mb-2">
            {day}{" "}
            <span className="text-faint dark:text-slate-500">
              ({entries.length})
            </span>
          </div>
          <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800">
            {entries.map((n) => (
              <li key={n.id}>
                {/* A DIV that behaves like a button, not a <button>: a
                    notification can now carry its own action buttons, and a
                    button inside a button is invalid and swallows the inner
                    click. Same shape the bell's rows already use. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => open(n)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open(n);
                    }
                  }}
                  className={
                    // Read changes the rail and the line's weight, nothing
                    // else: a faded read row faded its buttons too, so ones
                    // that still worked looked disabled (#7077).
                    "w-full text-left px-4 py-3 transition grid grid-cols-[minmax(0,1fr)_auto] sm:flex items-baseline gap-x-3 gap-y-1 cursor-pointer border-l-2 " +
                    (n.read_at
                      ? "border-l-transparent hover:bg-subtle/50 dark:hover:bg-slate-800/40"
                      : "border-l-accent dark:border-l-cobble-400 bg-cobble-50/50 dark:bg-cobble-900/15 hover:bg-subtle dark:hover:bg-slate-800/60")
                  }
                >
                  <span className="col-span-2 w-fit max-w-full [overflow-wrap:anywhere] px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300 shrink-0">
                    {n.org_name}
                  </span>
                  <div className="flex-1 min-w-0">
                    {/* Wrap to a couple of lines — a single truncated line cut
                        the key phrase off on mobile (the org badge squeezes the
                        row), so "Alex offered to share their…" lost its point. */}
                    <div className={"text-sm text-content dark:text-mortar-100 line-clamp-2 " + (n.read_at ? "font-normal" : "font-semibold")}>
                      {n.message}
                    </div>
                    {n.card?.body && !(n.card.rows?.length && n.actions?.length) && !repeatsMessage(n.card.body, n.message) && (
                      <div className="mt-0.5 border-l-2 border-line dark:border-slate-700 pl-2 text-xs text-muted dark:text-slate-400 line-clamp-2 break-words">
                        {n.card.body}
                      </div>
                    )}
                    <NotificationActionButtons n={n} />
                    <div className="text-[11px] text-faint dark:text-slate-500 mt-0.5">
                      {n.label ?? <Code>{n.event_type}</Code>} · {new Date(n.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                  {/* Its own two controls; a press here is not a press on the row. */}
                  <span className="shrink-0 flex items-center gap-0.5 self-center" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => (n.read_at ? markUnread.mutate(n.id) : markRead.mutate(n.id))}
                      aria-label={n.read_at ? "Mark unread" : "Mark read"}
                      title={n.read_at ? "Mark unread" : "Mark read"}
                      className="p-2 rounded text-faint hover:text-accent hover:bg-subtle dark:hover:bg-slate-800"
                    >
                      {n.read_at ? <Mail size={14} /> : <MailOpen size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove.mutate(n.id)}
                      aria-label="Delete"
                      title="Delete"
                      className="p-2 rounded text-faint hover:text-ember-600 hover:bg-subtle dark:hover:bg-slate-800"
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="w-full py-2 text-sm rounded border border-line dark:border-slate-700 text-accent hover:bg-subtle dark:hover:bg-slate-800/60 disabled:opacity-50"
        >
          {q.isFetchingNextPage ? "Loading…" : "Show older"}
        </button>
      )}

      <Link
        to="/me/activity"
        className="inline-flex text-sm text-accent hover:text-accent"
      >
        See your activity feed →
      </Link>
    </div>
  );
}
