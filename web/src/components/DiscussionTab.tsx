// The Discussion tab: what people have said about the record you are looking at.
//
// Unlike its neighbours in the rail, this tab does NOT travel with you — it IS
// the page you are on, and it empties when you navigate away from a record.
// That difference is the thing users trip over, so the tab carries the record's
// name as a context chip (the same affordance Cobb's "About: Rack 1" uses) and
// hides itself entirely on pages that are not a record. A visible, dead tab
// reads as broken; an absent one reads as "not here".
//
// Spec: docs/design-decisions/discussion-and-the-side-rail.md

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  CornerUpLeft,
  MessageSquare,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useToast, useConfirm } from "@cobblr/platform-web";
import { api, ApiError, type DiscussionComment } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { canEditComment, canResolveConversation } from "../lib/discussionPermissions";
import { useCurrentRecord } from "../lib/useCurrentRecord";
import { RailTabContent, openRail, useRailTab } from "./SideRail";
import { MentionText, useMentionPicker } from "./MentionText";
import { workspaceRoomSource, isWorkspaceRoom } from "@cobblr/platform-contract/workspace-room";

/** How often the open conversation re-reads itself. There is no push channel
 *  for comments, so a message somebody else posts reaches this tab by asking
 *  again; four seconds is fast enough to feel live and one small GET. */
export const LIVE_REFETCH_MS = 4_000;

/** The query options that keep a SHOWING conversation current.
 *
 *  Reported: a message sent from Discord "does not auto show up in the
 *  Discussions tab, she had to switch tabs back and forth to get the message
 *  to show up". The query only re-read on mount and on tab switch, so an
 *  open conversation was a snapshot. While the tab is showing it now polls
 *  (TanStack pauses interval polling while the browser tab is hidden), and
 *  coming back to the window re-reads at once. Hidden in the rail: nothing. */
export function conversationLiveness(active: boolean): {
  refetchInterval: number | false;
  refetchOnWindowFocus: boolean;
} {
  return { refetchInterval: active ? LIVE_REFETCH_MS : false, refetchOnWindowFocus: active };
}

/** How long a just-arrived message stays lit. Long enough to be seen from
 *  across the room, short enough that a busy thread is not a wall of amber. */
export const FRESH_MS = 8_000;

/** Which of these comments just ARRIVED: not in the set this tab had already
 *  shown, and not the reader's own (you know what you just sent). `seen` is
 *  null on the first read of a conversation, which is a baseline, not news.
 *
 *  Reported: a reply that landed in the open tab "is very bland and if she had
 *  not received the discord notification at the same time, she would not have
 *  realized that there was a response at all". A message that appears without
 *  anyone touching the page has to look like it appeared. */
export function arrivedComments(
  seen: Set<string> | null,
  comments: ReadonlyArray<{ id: string; author_kind: string; author_user_id: string | null }>,
  selfUserId: string | null,
): string[] {
  if (!seen) return [];
  return comments
    .filter((c) => !seen.has(c.id) && !(c.author_kind === "user" && c.author_user_id === selfUserId))
    .map((c) => c.id);
}

/** How long ago, in the shortest form that is still unambiguous. */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/** The quote above a reply.
 *
 *  Rendered LIVE from the comment it points at, never a stored copy: edit the
 *  original and every quote of it updates. A snapshot would drift, and the
 *  drift would be invisible.
 *
 *  Which creates one honesty problem worth solving. Reply "yes, agreed" to a
 *  question, let the question be edited, and the recorded agreement now answers
 *  different words. So when the original changed AFTER the reply was written,
 *  the quote says so. */
function Quote({
  id,
  comments,
  names,
}: {
  id: string;
  comments: DiscussionComment[];
  names: (userId: string) => string;
}) {
  const target = comments.find((c) => c.id === id);
  const reply = comments.find((c) => c.in_reply_to === id);
  const editedSince =
    !!target?.edited_at &&
    !!reply &&
    new Date(target.edited_at) > new Date(reply.created_at);

  const jump = () => {
    const el = document.getElementById(`c-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // A flash rather than a persistent highlight: it answers "which one" and
    // then gets out of the way.
    el.classList.add("bg-amber-400/20");
    window.setTimeout(() => el.classList.remove("bg-amber-400/20"), 1200);
  };

  // A quoted comment can be gone. Saying so keeps the reply readable, which is
  // usually the half that mattered.
  const gone = !target || !!target.deleted_at;

  return (
    <button
      type="button"
      onClick={jump}
      disabled={gone}
      className={
        "block w-full text-left border-l-2 border-line dark:border-slate-600 pl-2 mb-1 " +
        (gone ? "" : "hover:border-cobble-400 transition")
      }
    >
      <span className="block text-[11px] text-faint truncate">
        {gone ? (
          <span className="italic">message removed</span>
        ) : (
          <>
            <span className="font-medium">
              {target.author_kind === "assistant" ? "Cobb" : names(target.author_user_id ?? "")}
            </span>
            : {target.body}
          </>
        )}
      </span>
      {editedSince && (
        <span className="block text-[10px] text-faint italic">edited since this reply</span>
      )}
    </button>
  );
}

export function DiscussionTab() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const { user } = useAuth();
  const selfUserId = user?.id ?? null;
  const record = useCurrentRecord(activeSlug ?? "");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState("");
  const mentionRef = useRef<(() => void) | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  // "Don't ask Cobb" needs NO storage: suppressing simply means not summoning
  // him, and the comment is then an ordinary reply that nothing downstream has
  // to know about.
  const [suppressCobb, setSuppressCobb] = useState(false);

  // ALWAYS registered, even with no record in view.
  //
  // It used to register only on a record, and the reasoning was sound at the
  // time: off a record there would be one tab, no tab bar, and the rail would
  // look exactly as it always had. Then Pinned shipped and registers
  // unconditionally, so the bar shows everywhere regardless — and the only
  // thing the condition still achieved was making Discussion vanish from it.
  //
  // Which reads as a missing feature, not as "you are not on a record". A tab
  // that comes and goes as you navigate is worse than one that is always there
  // and sometimes says it has nothing to show.
  const { active } = useRailTab({
    id: "discussion",
    label: "Discussion",
    icon: <MessageSquare size={16} />,
    order: 1,
  });

  // On a record, its conversation. Off one, the WORKSPACE ROOM.
  //
  // This used to be `null` off a record and the tab said "open a record to talk
  // about it", which was a limitation invented by the tab rather than one the
  // platform had: a conversation is keyed by a source triple, and the workspace
  // has an id of its own, so the room needs no new table and no migration.
  //
  // Talking without pointing at something is the ordinary case. Docs has both
  // halves for the same reason: comment on a selection, or just say something.
  const src = record
    ? {
        source_module: record.sourceModule,
        source_type: record.sourceType,
        source_id: record.id,
      }
    : activeOrg
      ? workspaceRoomSource(activeOrg.id)
      : null;

  // The record itself, for the context chip. Same cached lookup the mention
  // chips use, so a record named in a comment and the record being discussed
  // resolve through one path.
  const subject = useQuery({
    queryKey: ["entity", activeSlug, record?.kind, record?.id],
    queryFn: () => api.lookupEntity(activeSlug, record!.kind, record!.id),
    enabled: !!activeSlug && !!record && active,
    staleTime: 60_000,
    retry: false,
  });

  const conv = useQuery({
    queryKey: ["discussion", activeSlug, src?.source_module, src?.source_type, src?.source_id],
    queryFn: () => api.getConversation(activeSlug, src!),
    // Only while showing: a mounted-but-hidden tab must not poll.
    enabled: !!activeSlug && !!src && active,
    ...conversationLiveness(active),
  });

  // What this tab has already shown, per conversation, so a message that turns
  // up later lights up and scrolls into view. The first read of a conversation
  // sets the baseline; switching conversations starts over.
  const convId = conv.data?.conversation?.id ?? null;
  const seenRef = useRef<{ conv: string | null; ids: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const list = conv.data?.comments;
    if (!list) return;
    const prior = seenRef.current && seenRef.current.conv === convId ? seenRef.current.ids : null;
    const arrived = arrivedComments(prior, list, selfUserId);
    seenRef.current = { conv: convId, ids: new Set(list.map((c) => c.id)) };
    if (arrived.length === 0) return;
    setFresh((prev) => new Set([...prev, ...arrived]));
    requestAnimationFrame(() => {
      document.getElementById(`c-${arrived[arrived.length - 1]}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    // No cleanup on purpose: every poll replaces conv.data, and a cleanup here
    // would cancel the fade before it ever fired.
    setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        for (const id of arrived) next.delete(id);
        return next;
      });
    }, FRESH_MS);
  }, [conv.data, convId, selfUserId]);

  // Names live in cobblr_meta, the comments in the tenant DB, so the join
  // happens here rather than in SQL. Cached workspace-wide; a comment stores an
  // id and never a name, so renaming somebody updates every comment they wrote.
  const members = useQuery({
    queryKey: ["members", activeSlug],
    queryFn: () => api.listMembers(activeSlug),
    enabled: !!activeSlug && active,
    staleTime: 5 * 60_000,
  });
  const nameOfUser = useMemo(() => {
    const by = new Map<string, string>();
    for (const m of members.data?.items ?? []) by.set(m.user_id, m.display_name || m.email);
    return (id: string) => by.get(id) ?? "someone";
  }, [members.data]);
  const nameOf = useMemo(() => {
    const by = new Map<string, string>();
    for (const m of members.data?.items ?? []) by.set(m.user_id, m.display_name || m.email);
    return (c: DiscussionComment) =>
      c.author_kind === "assistant"
        ? "Cobb"
        : c.author_user_id
          ? (by.get(c.author_user_id) ?? "Someone")
          : "Someone";
  }, [members.data]);

  const post = useMutation({
    mutationFn: (body: string) =>
      api.postComment(activeSlug, {
        ...src!,
        body,
        // Suppressing means not REPLYING to Cobb, which is the trigger itself.
        // Sending a "please don't" flag would put the rule in two places.
        in_reply_to: suppressCobb && cobbWillReply ? null : replyTo,
      }),
    onSuccess: () => {
      setDraft("");
      mentionRef.current?.();
      setReplyTo(null);
      setSuppressCobb(false);
      void qc.invalidateQueries({ queryKey: ["discussion", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't post that."),
  });

  const mention = useMentionPicker(draft, setDraft, taRef);
  // The mutation above is declared before the picker exists, so its success
  // handler reaches the reset through here rather than by reordering two blocks
  // that each have a reason to sit where they do.
  mentionRef.current = mention.reset;

  /** Both ways of sending go through here.
   *
   *  The composer holds NAMES and the server stores TOKENS, so something has to
   *  translate, and it has to be the same something for the button and for
   *  Enter — two copies of this line is how one of them ends up posting a
   *  sentence that mentions nobody. */
  const send = () => {
    const body = mention.resolve(draft).trim();
    if (body) post.mutate(body);
  };

  // Discord DMs are the difference between hearing about a mention now and
  // hearing about it whenever you next open the app. Someone who has not
  // connected Discord has no way to know that from in here, so this says it —
  // once, where the feature is, and dismissibly.
  //
  // Per-user and per-browser (localStorage) on purpose: it is a nudge, not a
  // setting, and a nudge that needs a migration to dismiss is a nudge that
  // should not exist.
  const [nudgeHidden, setNudgeHidden] = useState(
    () => localStorage.getItem("cobblr.discussion.discord-nudge") === "dismissed",
  );
  const commsPrefs = useQuery({
    queryKey: ["communication-prefs"],
    queryFn: () => api.meCommunicationPrefs(),
    enabled: active && !nudgeHidden,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const showDiscordNudge = !nudgeHidden && commsPrefs.data?.discord_verified === false;


  // Opening the tab IS reading it. Marking read on open rather than behind a
  // button is what keeps the inbox honest: an unread count you have to clear by
  // hand becomes a number people ignore.
  useEffect(() => {
    if (!active || !src || !activeSlug || !conv.data?.conversation) return;
    void api
      .markConversationRead(activeSlug, src)
      .then(() => qc.invalidateQueries({ queryKey: ["discussion-inbox", activeSlug] }))
      .catch(() => undefined);
    // Re-runs when the newest comment changes, so reading a conversation you
    // already had open still clears the dot.
  }, [active, activeSlug, conv.data?.conversation?.id, conv.data?.comments.length]);

  const follow = useMutation({
    mutationFn: (following: boolean) => api.followRecord(activeSlug, src!, following),
    onSuccess: (_r, following) => {
      toast.success(following ? "Following this" : "Not following this");
      void qc.invalidateQueries({ queryKey: ["discussion-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["discussion", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't change that."),
  });

  // The inbox already computes this per record; reading it from there avoids a
  // second endpoint that could answer differently.
  const inbox = useQuery({
    queryKey: ["discussion-inbox", activeSlug],
    queryFn: () => api.discussionInbox(activeSlug),
    enabled: !!activeSlug && active,
    staleTime: 30_000,
  });
  // `src` is null on a page that is not a record, which is exactly the case
  // this hook has to keep running for: the hook count must not depend on it.
  const following = !!inbox.data?.items.find(
    (i) =>
      !!src &&
      i.source_module === src.source_module &&
      i.source_type === src.source_type &&
      i.source_id === src.source_id,
  )?.following;

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteComment(activeSlug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["discussion", activeSlug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove that."),
  });

  // Editing your own words, in place. The row swaps its <p> for a small
  // textarea; save PATCHes and refetches through the same query key post and
  // delete invalidate, so an edit lands the same way a new comment does.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const edit = useMutation({
    mutationFn: (vars: { id: string; body: string }) =>
      api.editComment(activeSlug, vars.id, vars.body),
    onSuccess: () => {
      setEditingId(null);
      setEditDraft("");
      void qc.invalidateQueries({ queryKey: ["discussion", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save that."),
  });

  // Settle a conversation, or open it again. Keyed by the CONVERSATION id (the
  // resolve endpoint takes the conversation, not a comment), so it waits until
  // the conversation has loaded. Member and up — a guest can read but not close.
  const resolve = useMutation({
    mutationFn: (resolved: boolean) =>
      api.resolveConversation(activeSlug, conv.data!.conversation!.id, resolved),
    onSuccess: (_r, resolved) => {
      toast.success(resolved ? "Marked settled" : "Reopened");
      void qc.invalidateQueries({ queryKey: ["discussion", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["discussion-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't change that."),
  });
  const canResolve = canResolveConversation(activeOrg?.role);
  const resolved = !!conv.data?.conversation?.resolved_at;

  // No record in view: the tab is here, and says what it is for. Every hook has
  // already run above, so this is a plain render branch and not a conditional
  // hook (lint:hooks-after-return watches that, and would have caught it).
  if (!src) {
    return (
      <RailTabContent id="discussion" title={<>Discussion</>}>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
          <p className="text-sm text-faint dark:text-slate-500 italic">
            Pick a workspace to talk in.
          </p>
          <p className="text-sm text-muted dark:text-slate-400">
            A conversation belongs to the thing it is about, so this fills in
            once you are looking at a part, a machine, a location, a project.
          </p>
          {/* No /w/<slug> prefix: that IS the router basename, so writing it
              here produces /w/slug/w/slug/discussion. Every other link in the
              rail is a bare path for the same reason. */}
          <Link
            to="/discussion"
            className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
          >
            <MessageSquare size={13} />
            Everything people are saying
          </Link>
        </div>
      </RailTabContent>
    );
  }

  const comments = conv.data?.comments ?? [];

  // The same rule the server applies, shown BEFORE sending. The failure this
  // prevents: replying "ok, agreed, let's take it" to Cobb's answer, addressed
  // to a person, and getting an answer from Cobb anyway. Harmless once,
  // irritating by the fourth time.
  //
  // Not a hook, so it is safe below the early return. The `inbox` query that
  // used to sit here has moved ABOVE the guard, where it belongs.
  const repliedToComment = comments.find((c) => c.id === replyTo);
  const cobbWillReply =
    draft.includes("[[cobb]]") || repliedToComment?.author_kind === "assistant";

  return (
    <RailTabContent
      id="discussion"
      title={<>Discussion</>}
      actions={
        <>
          {/* Settle / reopen. Member and up; hidden entirely for a guest and
              until the conversation exists (nothing to resolve on an empty
              thread). The `settled` badge on the inbox row has had no way to be
              set until this control existed. */}
          {canResolve && conv.data?.conversation && (
            <button
              type="button"
              onClick={() => resolve.mutate(!resolved)}
              disabled={resolve.isPending}
              title={
                resolved
                  ? "Settled. Click to reopen."
                  : "Mark this conversation settled"
              }
              aria-pressed={resolved}
              className={
                "p-1 transition " +
                (resolved
                  ? "text-emerald-500"
                  : "text-faint hover:text-content dark:hover:text-mortar-200")
              }
            >
              {resolved ? <RotateCcw size={14} /> : <CheckCircle2 size={14} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => follow.mutate(!following)}
            disabled={follow.isPending}
            title={
              following
                ? "You hear about new comments here. Click to stop."
                : "Hear about new comments on this record"
            }
            aria-pressed={following}
            className={
              "p-1 transition " +
              (following ? "text-amber-500" : "text-faint hover:text-content dark:hover:text-mortar-200")
            }
          >
            {following ? <Bell size={14} /> : <BellOff size={14} />}
          </button>
        </>
      }
    >
      <div className="flex-1 min-h-0 flex flex-col">
        {showDiscordNudge && (
          <div className="mx-4 mt-3 shrink-0 flex items-start gap-2 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900 px-3 py-2">
            <MessageSquare size={13} className="shrink-0 mt-0.5 text-cobble-700 dark:text-cobble-200" />
            <p className="flex-1 min-w-0 text-[11px] text-cobble-800 dark:text-cobble-100">
              {/* /me/communication (the Delivery tab), NOT /me/notifications (Inbox).
                  The Connect Discord button lives on Delivery; Inbox is a list of
                  things that already happened, so this CTA used to land on a page
                  that cannot do the thing it offers. */}
              <Link to="/me/communication" className="underline hover:no-underline">
                Connect Discord
              </Link>{" "}
              and someone mentioning you here reaches you straight away, with a
              reply box on the message. Without it, you find out next time you
              open Cobblr.
            </p>
            <button
              type="button"
              onClick={() => {
                localStorage.setItem("cobblr.discussion.discord-nudge", "dismissed");
                setNudgeHidden(true);
              }}
              className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-200 transition"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="px-4 pt-3 shrink-0 flex items-center gap-2 flex-wrap">
          {/* The record's NAME. This said "machines:machine" until somebody
              looked at it — the machine's version of the answer, in the one
              place whose whole job is telling you which record you are talking
              about. (The same mistake Linked entities carried for as long as it
              existed.) */}
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900 px-2 py-1 text-[11px] text-cobble-800 dark:text-cobble-100 max-w-full"
            title={record?.kind ?? activeOrg?.name}
          >
            {/* The room is not ABOUT anything, so it does not claim to be. It
                says where you are talking, which is the useful fact when the
                same tab is a record thread one moment and the room the next. */}
            <span className="shrink-0 opacity-70">{record ? "About:" : "In:"}</span>
            <span className="truncate">
              {record ? (subject.data?.title ?? "…") : (activeOrg?.name ?? "this workspace")}
            </span>
          </span>
          {resolved && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 px-2 py-1 text-[11px] font-mono uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
              title="This conversation has been marked settled."
            >
              <Check size={11} /> settled
            </span>
          )}
        </div>

        {/* min-h-0: a flex child defaults to min-height:auto, so a long thread
            grew this list past the panel and pushed the composer below the
            fold on a phone ("the bottom is cut off sometimes"). With it, the
            list scrolls and the composer stays pinned. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
          {conv.isLoading && <p className="text-xs text-faint">loading…</p>}
          {!conv.isLoading && comments.length === 0 && (
            <p className="text-sm text-faint dark:text-slate-500 italic">
              {isWorkspaceRoom(src)
                ? "Nothing said in here yet. This is the whole workspace, so anything that is not about one particular record belongs here."
                : "Nothing said about this yet. Whatever you write here stays with the record, so the next person to open it sees it too."}
            </p>
          )}
          {comments.map((c) => (
            <div
              key={c.id}
              id={`c-${c.id}`}
              data-fresh={fresh.has(c.id) ? "1" : undefined}
              className={
                "group scroll-mt-4 -mx-2 px-2 py-1.5 rounded-md transition-colors duration-1000 " +
                (fresh.has(c.id)
                  ? "bg-amber-100 dark:bg-amber-900/40 ring-1 ring-amber-300 dark:ring-amber-700"
                  : "ring-0 ring-transparent")
              }
            >
              <div className="flex items-baseline gap-2 text-[11px]">
                <span className="font-medium text-content dark:text-mortar-100">{nameOf(c)}</span>
                {c.author_kind === "assistant" && c.requested_by && (
                  <span className="text-faint">asked by {nameOfUser(c.requested_by)}</span>
                )}
                <span className="text-faint">{ago(c.created_at)}</span>
                {c.edited_at && <span className="text-faint italic">edited</span>}
                {fresh.has(c.id) && (
                  <span className="rounded-full bg-amber-400 text-cobble-900 text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 animate-pulse">
                    new
                  </span>
                )}
              </div>
              {c.in_reply_to && <Quote id={c.in_reply_to} comments={comments} names={nameOfUser} />}
              {/* THE TOOLS LIVE WITH THE MESSAGE.
                  They used to sit in the header row on `ml-auto`, which pinned
                  them to the far edge of the panel: the name and the time on
                  the left, two icons stranded across a gap, and the message
                  itself on a third line. Three pieces of one thing, none of
                  them touching.
                  Beside the text instead, the way a chat app does it, and
                  revealed on hover through the shared `hover-reveal` — which
                  stays visible on a touch screen, where there is no hover to
                  reveal them with. */}
              <div className="flex items-start gap-1">
                {/* w-fit, or the tools are back at the far edge.
                    A <p> is block-level and fills its container, so the flex
                    row's first child was full width and the icons sat against
                    the panel border again — the same disjointed look, one line
                    lower. Hugging the text is what puts them BESIDE the
                    message; a long message still fills and wraps, and then the
                    edge is where they belong anyway. */}
                <div className="min-w-0 w-fit max-w-full">
                  {editingId === c.id ? (
                    // Inline editor: the raw body, so a mention token you keep
                    // stays a token. Enter saves, Escape cancels — the same keys
                    // the composer uses, so muscle memory carries over.
                    <div className="flex flex-col gap-1.5">
                      <textarea
                        value={editDraft}
                        autoFocus
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const body = editDraft.trim();
                            if (body) edit.mutate({ id: c.id, body });
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                          }
                        }}
                        rows={2}
                        className="w-full resize-none px-3 py-2 text-base sm:text-sm rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-200 leading-relaxed"
                      />
                      <div className="flex items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          onClick={() => {
                            const body = editDraft.trim();
                            if (body) edit.mutate({ id: c.id, body });
                          }}
                          disabled={!editDraft.trim() || edit.isPending}
                          className="inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-1 transition disabled:opacity-50"
                        >
                          <Check size={11} /> Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="text-faint hover:text-content dark:hover:text-mortar-200 transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : c.status === "pending" ? (
                    <p className="text-sm text-faint dark:text-slate-500 italic">Cobb is thinking…</p>
                  ) : c.status === "failed" ? (
                    // Failure says so out loud. A silent non-answer looks like a
                    // broken feature and leaves nobody sure whether to ask again.
                    <p className="text-sm text-ember-500 italic">
                      {c.body || "Cobb could not answer."}
                    </p>
                  ) : c.deleted_at ? (
                    <p className="text-sm text-faint dark:text-slate-500 italic">message removed</p>
                  ) : (
                    <p className="text-sm text-content dark:text-mortar-200">
                      <MentionText body={c.body} names={(id) => nameOfUser(id)} />
                    </p>
                  )}
                </div>
                {!c.deleted_at && editingId !== c.id && (
                  <span className="hover-reveal shrink-0 flex items-center gap-0.5 pl-1">
                    <button
                      type="button"
                      onClick={() => {
                        setReplyTo(c.id);
                        taRef.current?.focus();
                      }}
                      className="p-1 rounded text-faint hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/60 transition"
                      aria-label="Reply to this comment"
                      title="Reply"
                    >
                      <CornerUpLeft size={13} />
                    </button>
                    {/* Edit only your OWN, live comment — the same rule the
                        server enforces on PATCH. Cobb's posts and other people's
                        never show a pencil; the "edited" badge above only
                        becomes reachable through here. */}
                    {canEditComment(c, selfUserId) && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(c.id);
                          setEditDraft(c.body);
                        }}
                        className="p-1 rounded text-faint hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/60 transition"
                        aria-label="Edit comment"
                        title="Edit"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Remove this comment?",
                          message: "The text goes. Anyone who replied to it keeps their reply.",
                          confirmLabel: "Remove",
                          destructive: true,
                        });
                        if (ok) remove.mutate(c.id);
                      }}
                      className="p-1 rounded text-faint hover:text-ember-500 hover:bg-subtle/60 dark:hover:bg-slate-800/60 transition"
                      aria-label="Remove comment"
                      title="Remove"
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-line dark:border-slate-700 p-3 shrink-0">
          {replyTo && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-2 py-1.5">
              <CornerUpLeft size={12} className="shrink-0 mt-0.5 text-faint" />
              <span className="flex-1 min-w-0 text-[11px] text-muted truncate">
                {(() => {
                  const t = comments.find((c) => c.id === replyTo);
                  if (!t) return "replying";
                  const who =
                    t.author_kind === "assistant" ? "Cobb" : nameOfUser(t.author_user_id ?? "");
                  return `${who}: ${t.body}`;
                })()}
              </span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-200 transition"
                aria-label="Cancel reply"
              >
                <X size={12} />
              </button>
            </div>
          )}
          {cobbWillReply && (
            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1">
                <Sparkles size={11} className="text-amber-500" />
                {suppressCobb ? "Cobb will stay out of it" : "Cobb will reply"}
              </span>
              <button
                type="button"
                onClick={() => setSuppressCobb((v) => !v)}
                className="text-faint hover:text-accent underline transition"
              >
                {suppressCobb ? "ask Cobb after all" : "don't ask Cobb"}
              </button>
            </div>
          )}
          {mention.element}
          <div className="flex items-end gap-2">
            {/* The placeholder is OURS, not the textarea's. iOS Safari renders a
                textarea's native placeholder in a box sized from the text it
                just cleared, so after every send the hint came back as "Say"
                and nothing else (reported twice, 2026-08-26). A span over an
                empty box wraps and clips like any other text. */}
            <div className="relative flex-1 min-w-0">
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                mention.onInput(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={(e) => {
                // The picker eats the keys it needs (arrows, Enter, Escape)
                // while it is open, so Enter completes a mention instead of
                // sending a half-written sentence.
                if (mention.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              aria-label="Say something about this"
              data-testid="discussion-composer"
              className="block w-full resize-none px-3 py-2 text-base sm:text-sm rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-200 leading-relaxed"
            />
            {!draft && (
              <span
                aria-hidden
                data-testid="discussion-placeholder"
                className="pointer-events-none absolute left-3 right-3 top-2 truncate text-base sm:text-sm leading-relaxed text-faint dark:text-slate-500"
              >
                Say something… (@ to mention)
              </span>
            )}
            </div>
            <button
              type="button"
              onClick={send}
              disabled={!draft.trim() || post.isPending}
              className="h-9 w-9 shrink-0 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white flex items-center justify-center transition disabled:opacity-50"
              aria-label="Post comment"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </RailTabContent>
  );
}

/** The inline pointer on the record itself.
 *
 *  Deliberately a PREVIEW and not a second implementation: it reads the same
 *  conversation, renders no composer, and its only affordance is opening the
 *  rail. The rail is where you converse; this is where you find out there is
 *  something to read. (Same relationship the attachment thumbnail strip has to
 *  the file viewer.) */
export function DiscussionPreview({
  sourceModule,
  sourceType,
  sourceId,
  compact = false,
}: {
  sourceModule: string;
  sourceType: string;
  sourceId: string;
  /** Modal detail views (machines, inventory) render their side-cars as a row
   *  of pills rather than sections. Without a compact form, discussion had no
   *  entry point AT ALL on those pages — and most detail views in this app are
   *  modals, so the feature was invisible exactly where it is most used. */
  compact?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const conv = useQuery({
    queryKey: ["discussion", activeSlug, sourceModule, sourceType, sourceId],
    queryFn: () =>
      api.getConversation(activeSlug, {
        source_module: sourceModule,
        source_type: sourceType,
        source_id: sourceId,
      }),
    enabled: !!activeSlug && !!sourceId,
    staleTime: 30_000,
  });

  const count = conv.data?.count ?? 0;
  const latest = [...(conv.data?.comments ?? [])].reverse().find((c) => !c.deleted_at);

  // A PILL when there is nothing to read, whatever the caller asked for.
  //
  // The section form is a full-width bordered box, and on an empty record it
  // says "Nothing said about this yet" in a box the size of a paragraph. One of
  // those on a detail page is heavy; a list of them, one per row, is what the
  // scan inbox looked like — every item carrying an empty container for
  // something nobody had written. It reads as a text field to fill in.
  //
  // Tags already had the right answer next door: an empty tag list is a small
  // "+ Tag" pill, not an empty box announcing itself. So an empty conversation
  // is a "Discuss" pill, and the section earns its room only once there is
  // something in it to show.
  if (compact || count === 0) {
    // Matches the Tag / File / Link pills beside it: same size, same shape, and
    // it says how many so an empty record and a busy one do not look alike.
    return (
      <button
        type="button"
        onClick={() => openRail("discussion")}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition"
      >
        <MessageSquare size={10} />
        {count > 0 ? `${count} comment${count === 1 ? "" : "s"}` : "Discuss"}
      </button>
    );
  }

  return (
    <section>
      {/* The count is of what is actually there: a removed comment leaves a
          tombstone so replies still read, but it is not something to go and
          look at. */}
      <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
        // discussion{count > 0 ? ` (${count})` : ""}
      </h3>
      <button
        type="button"
        onClick={() => openRail("discussion")}
        className="w-full text-left rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
      >
        {latest ? (
          <>
            <span className="block text-sm text-content dark:text-mortar-200 line-clamp-2 break-words">
              {latest.body}
            </span>
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mt-1">
              {count === 1 ? "1 comment" : `${count} comments`} · open to reply
            </span>
          </>
        ) : (
          <span className="text-sm text-faint dark:text-slate-500 italic">
            Nothing said about this yet. Start a discussion the rest of the workspace can see.
          </span>
        )}
      </button>
    </section>
  );
}
