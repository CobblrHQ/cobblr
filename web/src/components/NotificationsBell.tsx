// Bell icon in the header — badge with unread count, click opens the inbox.
// Cross-workspace inbox: every notification for the user is visible regardless
// of which workspace they're currently viewing. Each row shows the workspace
// name and clicking switches the active workspace + navigates to link_url so
// accept/revoke flows still land on the right page.
//
// The inbox renders in one of two modes, toggleable + remembered (per request
// from feedback — the small dropdown felt cramped): a compact DROPDOWN popover,
// or a full-height right SIDEBAR (same shape as the AI chat / ChatWidget). The
// sidebar portals to <body> so the header's backdrop-blur can't trap its
// position:fixed (CLAUDE.md modal note).

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, PanelRight, PanelRightClose, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { api, type CrossOrgNotificationEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { SidePanel } from "./SidePanel";

type Mode = "dropdown" | "sidebar";
const MODE_KEY = "cobblr.notif.mode";

/** Notifications whose MESSAGE is the whole point — clicking marks them read
 *  and stays put. A reply to your feedback reads like a conversation, not a
 *  link (reported 2026-08-01). */
const NO_NAVIGATE = new Set(["platform.feedback.replied"]);

export function NotificationsBell({ panelOnly = false, asRow = false }: { panelOnly?: boolean; asRow?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [storedMode, setMode] = useState<Mode>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY)) === "sidebar" ? "sidebar" : "dropdown",
  );
  // Full-sidebar foot: the anchored dropdown would clip against the nav
  // column / open off the bottom of the screen — always use the full-height
  // right panel there. The user's dropdown/sidebar preference still applies
  // in the top bar.
  const mode: Mode = panelOnly ? "sidebar" : storedMode;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { activeSlug, setActiveSlug } = useActiveOrg();

  function chooseMode(m: Mode) {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode — fine, just won't persist */
    }
  }

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

  // Close on outside click — both modes (reported: clicking outside the sidebar
  // should dismiss it, not persist). The sidebar portals to <body>, so its panel
  // isn't inside wrapperRef; check sidebarRef too so a click INSIDE the panel
  // (mark-read, toggle) doesn't close it.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t)) return;
      if (sidebarRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const count = unread.data?.count ?? 0;
  const here = unreadHere.data?.count ?? 0;
  // Every unread is in OTHER workspaces → sky blue (heads-up, not here).
  const otherOnly = count > 0 && here === 0;
  const other = Math.max(0, count - here);

  /** A stored link_url as something React Router can route.
   *
   *  `navigate()` takes a PATH. An ABSOLUTE url ("https://cobblr.example.com/w/x/scan")
   *  matches no route, so it fell through to the catch-all and dumped you on
   *  the dashboard — which is what every emailed-receipt notification did
   *  (reported 2026-08-01). Producers now store relative paths, but notification
   *  rows are IMMUTABLE (only read_at / delivered_via are ever updated), so
   *  every row written before that fix still carries an absolute url forever.
   *  Hence: strip our own origin here rather than only fixing it upstream.
   *  A link to some OTHER origin is not ours to route — open it in a new tab. */
  function routeFor(link: string): { path?: string; external?: string } {
    if (!/^https?:\/\//i.test(link)) return { path: link.startsWith("/") ? link : `/${link}` };
    try {
      const u = new URL(link);
      if (u.origin === window.location.origin) return { path: `${u.pathname}${u.search}${u.hash}` };
      return { external: link };
    } catch {
      return {};
    }
  }

  function handleItemClick(n: CrossOrgNotificationEntry) {
    if (!n.read_at) markRead.mutate(n.id);
    // Some notifications have no destination worth taking you to: a reply to
    // your feedback is the message ITSELF, so hijacking the click to a queue
    // page is a detour (the row keeps a quiet "view thread" link for anyone who
    // wants it). Clicking just marks it read.
    if (NO_NAVIGATE.has(n.event_type)) { setOpen(false); return; }
    // A workspace-invite is about ANOTHER workspace you're not in yet — it's
    // scoped to one of your own only so it surfaces. Don't switch to that scope
    // workspace; just open the accept link.
    if (n.event_type !== "workspace.invited") setActiveSlug(n.org_slug);
    if (n.link_url) {
      const { path, external } = routeFor(n.link_url);
      if (path) navigate(path);
      else if (external) window.open(external, "_blank", "noopener");
    }
    setOpen(false);
  }

  // Shared inbox body (header actions + the list + "see all"). Rendered inside
  // both the dropdown popover and the sidebar so the two modes never drift.
  const body = (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b border-line dark:border-slate-700 shrink-0">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">notifications</div>
        <div className="flex items-center gap-2">
          {count > 0 && (
            <button
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="text-[10px] font-mono text-accent hover:text-accent transition"
            >
              mark all read
            </button>
          )}
          {mode === "dropdown" ? (
            <button
              onClick={() => chooseMode("sidebar")}
              title="Dock as a side panel"
              aria-label="Dock notifications as a side panel"
              className="text-faint hover:text-accent dark:text-slate-500 dark:hover:text-cobble-300 transition"
            >
              <PanelRight size={14} />
            </button>
          ) : (
            <>
              <button
                onClick={() => chooseMode("dropdown")}
                title="Collapse to a dropdown"
                aria-label="Collapse notifications to a dropdown"
                className="text-faint hover:text-accent dark:text-slate-500 dark:hover:text-cobble-300 transition"
              >
                <PanelRightClose size={16} />
              </button>
              <button
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close notifications"
                className="text-faint hover:text-content dark:text-slate-500 dark:hover:text-mortar-200 transition"
              >
                <X size={16} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className={mode === "sidebar" ? "flex-1 overflow-y-auto" : ""}>
        {list.isLoading && <div className="px-3 py-4 text-[11px] text-faint">loading…</div>}
        {list.data && list.data.items.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-faint italic">No notifications yet.</div>
        )}
        {/* Each notification is its own rounded "bubble" card with breathing room
            between them (space-y), not a border-divided wall of text — the
            reported gripe was that runs of notifications blur into one block.
            Unread cards get an accent tint + left rail so they stand out from
            the muted, already-read ones. */}
        <ul className="px-2 py-2 space-y-2">
          {list.data?.items.map((n) => {
            const isUnread = !n.read_at;
            return (
              <li
                key={n.id}
                className={
                  "group flex items-stretch gap-1 rounded-xl border overflow-hidden transition " +
                  (isUnread
                    ? "border-l-2 border-cobble-200 border-l-accent dark:border-slate-700 dark:border-l-cobble-400 bg-cobble-50/50 dark:bg-cobble-900/15 hover:bg-cobble-50 dark:hover:bg-cobble-900/25"
                    : "border-line dark:border-slate-800 bg-subtle/40 dark:bg-slate-800/30 opacity-70 hover:opacity-100 hover:bg-subtle dark:hover:bg-slate-800/50")
                }
              >
                {/* Body click = open it (navigate + mark read). A clickable div, not
                    a <button>, so the markdown body can use block elements
                    (blockquote/p) — those are invalid nested inside a button. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => handleItemClick(n)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleItemClick(n);
                    }
                  }}
                  className="flex-1 min-w-0 text-left px-3 py-2.5 cursor-pointer"
                >
                  {/* Message "header": who + when up top, like a chat bubble's
                      sender/timestamp line — visually separates it from the body.
                      flex-wrap so the timestamp wraps instead of clipping "PM". */}
                  <div className="text-[10px] font-mono text-faint dark:text-slate-500 mb-1.5 flex items-center gap-1.5 flex-wrap">
                    <span className="px-1.5 py-0.5 rounded-full bg-cobble-100 dark:bg-cobble-900/40 text-accent dark:text-cobble-300 font-semibold uppercase tracking-wider">
                      {n.event_type === "workspace.invited" ? "invite" : n.org_name}
                    </span>
                    <span>{new Date(n.created_at).toLocaleString()}</span>
                  </div>
                  {/* Render the message as markdown so a quoted report (Discord-style
                      "> …") shows as a block quote instead of a literal ">". */}
                  <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-content dark:text-mortar-100 prose-p:my-1 prose-blockquote:my-1 break-words">
                    <ReactMarkdown>{n.message}</ReactMarkdown>
                  </div>
                  {/* A no-navigate notification still has somewhere to go for
                      anyone who wants it — just not by hijacking the click. */}
                  {NO_NAVIGATE.has(n.event_type) && n.link_url && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!n.read_at) markRead.mutate(n.id);
                        setActiveSlug(n.org_slug);
                        const { path } = routeFor(n.link_url!);
                        if (path) navigate(path);
                        setOpen(false);
                      }}
                      className="mt-1.5 text-[11px] text-faint dark:text-slate-500 hover:text-accent transition"
                    >
                      view thread →
                    </button>
                  )}
                </div>
                {/* Mark read WITHOUT navigating — a checkmark (not an ×) so it reads
                    as "acknowledge", not "delete" (reported). */}
                {isUnread && (
                  <button
                    onClick={() => markRead.mutate(n.id)}
                    disabled={markRead.isPending}
                    title="Mark as read"
                    aria-label="Mark notification as read"
                    className="shrink-0 px-2 text-faint hover:text-accent dark:text-slate-500 dark:hover:text-cobble-300 transition"
                  >
                    <Check size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <Link
        to="/me/notifications"
        onClick={() => setOpen(false)}
        className="block px-3 py-2 border-t border-line dark:border-slate-700 text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent transition text-center shrink-0"
      >
        see all →
      </Link>
    </>
  );

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={asRow ? "relative " + "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition" : "text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-100 transition p-1.5 relative"}
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
        {/* Always a normal bell — a struck-through (BellOff) icon reads as
            "notifications muted", which is wrong; zero unread is just an empty
            badge, not a disabled state. */}
        <Bell size={14} className="shrink-0" />
        {asRow && <span>Notifications{count > 0 ? ` (${count})` : ""}</span>}
        {count > 0 && !asRow && (
          <span
            className={`absolute -top-0.5 -right-0.5 text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-1 leading-none ${
              otherOnly ? "bg-sky-600 text-white" : "bg-ember-500 text-mortar-50"
            }`}
            aria-label={otherOnly ? `${count} unread in other workspaces` : `${count} unread`}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {/* DROPDOWN mode — compact popover anchored under the bell. */}
      {open && mode === "dropdown" && (
        <div className="absolute right-0 top-9 w-80 max-h-96 overflow-y-auto rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-50 flex flex-col">
          {body}
        </div>
      )}

      {/* SIDEBAR mode — the shared right panel (same one Ask Cobb uses): a
          full-width sheet under the navbar on a phone, a right drawer on
          desktop. */}
      {open && mode === "sidebar" && (
        <SidePanel width="sm:w-[min(100vw,420px)]" panelRef={sidebarRef}>
          {body}
        </SidePanel>
      )}
    </div>
  );
}
