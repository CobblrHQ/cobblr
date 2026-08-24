// One place to answer everything.
//
// A conversation per record is the right shape for reading a record, and the
// wrong shape for keeping up: it asks you to remember which printers to go back
// and reopen. This is the other half — everything with something new in it, in
// one list, sorted by what happened last.
//
// Three lanes, in the order attention is actually owed:
//   addressed to me  — somebody used my name. This is the one that cannot wait.
//   new              — unread on something I follow.
//   all              — everything I follow, including what I have read.
//
// Spec: docs/design-decisions/discussion-and-the-side-rail.md

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AtSign } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { api, type DiscussionInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useDetailRoute } from "../lib/useDetailRoute";
import { isWorkspaceRoom } from "@cobblr/platform-contract/workspace-room";

type Lane = "me" | "new" | "all";

function ago(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/** One row, named by the record rather than by its kind. */
function InboxRow({ item }: { item: DiscussionInboxItem }) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const detailRoute = useDetailRoute(activeSlug ?? "");
  const kind = `${item.source_module}:${item.source_type}`;
  // The room is not about a record, so there is nothing to look up. Asking
  // anyway returns nothing and renders as "(deleted)" — a workspace room that
  // says it was deleted is worse than no room at all.
  const room = isWorkspaceRoom(item);
  const q = useQuery({
    queryKey: ["entity", activeSlug, kind, item.source_id],
    queryFn: () => api.lookupEntity(activeSlug, kind, item.source_id),
    enabled: !!activeSlug && !room,
    staleTime: 60_000,
    retry: false,
  });
  const to = room ? "/discussion" : detailRoute(kind, item.source_id);
  const label = room
    ? `${activeOrg?.name ?? "Workspace"} · everyone`
    : q.isError
      ? "(deleted)"
      : (q.data?.title ?? "…");

  const body = (
    <div className="flex items-center gap-3 min-w-0">
      {/* Unread is a dot, not a bold row: a list where half the rows shout is
          one you stop reading. */}
      <span
        className={
          "shrink-0 w-2 h-2 rounded-full " +
          (item.unread ? "bg-amber-400" : "bg-transparent")
        }
        aria-label={item.unread ? "unread" : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-content dark:text-mortar-100 truncate">
            {label}
          </span>
          {item.addressed_to_me && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-amber-400 text-cobble-900">
              <AtSign size={9} /> you
            </span>
          )}
          {item.resolved_at && (
            <span className="shrink-0 text-[10px] font-mono uppercase tracking-widest text-faint">
              settled
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint truncate">
          {room ? "the whole workspace" : kind} · {item.comments}{" "}
          {item.comments === 1 ? "comment" : "comments"} ·{" "}
          {ago(item.latest_at)}
        </div>
      </div>
    </div>
  );

  const card =
    "block rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3";
  return (
    <li>
      {to ? (
        <Link
          to={to}
          className={card + " hover:border-cobble-300 dark:hover:border-cobble-700 transition"}
        >
          {body}
        </Link>
      ) : (
        <div className={card}>{body}</div>
      )}
    </li>
  );
}

export function DiscussionInboxPage() {
  const { activeSlug } = useActiveOrg();
  const [lane, setLane] = useState<Lane>("me");
  const [q, setQ] = useState("");
  usePageTitle("Discussion");

  const inbox = useQuery({
    queryKey: ["discussion-inbox", activeSlug, q],
    queryFn: () => api.discussionInbox(activeSlug, q || undefined),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });

  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data]);
  const lanes = useMemo(
    () => ({
      me: items.filter((i) => i.addressed_to_me),
      new: items.filter((i) => i.unread),
      all: items,
    }),
    [items],
  );
  const shown = lanes[lane];

  const tab = (id: Lane, label: string, n: number) => (
    <button
      key={id}
      type="button"
      onClick={() => setLane(id)}
      className={
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition " +
        (lane === id
          ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100 font-medium"
          : "text-muted hover:text-content dark:hover:text-mortar-200")
      }
    >
      {label}
      {n > 0 && (
        <span className="text-[10px] font-mono text-faint">{n > 99 ? "99+" : n}</span>
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Discussion</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          what people are saying about your things
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search what was said…"
          className="flex-1 min-w-[12rem] px-3 py-1.5 text-sm rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-200"
        />
      </div>

      <div className="flex items-center gap-1">
        {tab("me", "Addressed to me", lanes.me.length)}
        {tab("new", "New", lanes.new.length)}
        {tab("all", "All", lanes.all.length)}
      </div>

      {inbox.isLoading && <p className="text-xs text-faint">loading…</p>}

      {!inbox.isLoading && shown.length === 0 && (
        <div className="border border-dashed border-line dark:border-slate-700 rounded-md p-6 text-center text-sm text-faint italic">
          {lane === "me"
            ? q
              ? "Nothing you were named in matches that."
              : "Nobody has named you in a discussion yet."
            : lane === "new"
              ? "Nothing new. Everything you follow is read."
              : "You are not following any discussions yet. Comment on a record and it starts following you back."}
        </div>
      )}

      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((i) => (
            <InboxRow key={i.conversation_id} item={i} />
          ))}
        </ul>
      )}
    </div>
  );
}
