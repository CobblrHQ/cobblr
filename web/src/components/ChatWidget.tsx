// Floating AI chat — bottom-right launcher → RIGHT SIDEBAR. Agentic: the
// assistant chats AND can DO things — it proposes a create/action the user
// CONFIRMS before it runs (core-ai /chat → proposal → /chat/execute). Assistant
// messages render markdown; the input auto-grows. Portals to <body> so the
// header's backdrop-blur can't trap its position:fixed (CLAUDE.md modal note).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Send, Check, Eye, PencilLine, Trash2 } from "lucide-react";
import { api, ApiError, type AiChatProposal, type AiChatResponse, type BundleValidationPreview } from "../lib/api";
import { readSse } from "../lib/sse";
import { Cobb, CobbBust, CobbHead, COBB_POSES, type CobbPose } from "./Cobb";
import { useNavigate } from "react-router-dom";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { getChatPageContext } from "../lib/chat-context";
import { useDetailRoute } from "../lib/useDetailRoute";
import { useAiStatus, AiOffNotice } from "./AiStatusNotice";
import { SidePanel } from "./SidePanel";

// Shown only if the basic-mode endpoint itself is unreachable (network error) —
// the server otherwise always returns a reply (its own no-match nudge).
const BASIC_FALLBACK =
  "I couldn't reach the assistant just now. For anything about your workspace, connect AI using the link at the top.";

// Chat history is cached per-workspace in localStorage so a page refresh doesn't
// wipe the conversation. We store ONLY the plain text turns — never the live
// interactive state (pending proposals, build-draft polls, undo handles), which
// would be stale on reload. Capped so it can't grow unbounded.
const CHAT_STORE_PREFIX = "cobblr.cobbchat.";
const CHAT_STORE_MAX = 100;
function chatStoreKey(slug: string | null | undefined): string | null {
  return slug ? `${CHAT_STORE_PREFIX}${slug}` : null;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  proposal?: AiChatProposal; // assistant proposed a write — needs confirm
  buildPreview?: BundleValidationPreview; // build-proposal: what applying enables/adds
  buildSeedCount?: number; // build-proposal: starter records apply will create
  building?: boolean; // a whole-workspace build is running in the background (poll)
  buildDraftId?: string; // matches the polled draft (stable across new messages)
  resolved?: boolean; // proposal confirmed or cancelled
  ledgerId?: string; // an EXECUTED write's change-ledger row — the Undo handle
  undoable?: boolean;
  undone?: boolean; // this write was undone from the chat
  entityKind?: string; // an executed CREATE's entity — powers a "View it" link
  entityId?: string;
}

const kindLabel = (id: string) => id.split(":")[1] ?? id;

/** The write-mode chip: Ask (quiet default) → Auto (bold — changes apply
 *  immediately, all undoable) → Off (amber). Click cycles. */
function WriteModeChip({ mode, onCycle }: { mode: "off" | "ask" | "auto"; onCycle: () => void }) {
  const looks = {
    ask: {
      label: "Changes: ask",
      cls: "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:border-cobble-400",
      title:
        "Cobb proposes creates/updates/deletes/actions and each needs your Confirm. Click for Auto (apply immediately, undoable).",
    },
    auto: {
      label: "Changes: auto",
      cls: "border-cobble-500 bg-cobble-600 text-white",
      title:
        "Record changes apply IMMEDIATELY: every one is tracked and undoable (actions still ask; they can be irreversible). Click for Off.",
    },
    off: {
      label: "Changes: off",
      cls: "border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400",
      title: "Cobb won't propose or make any changes. Click for Ask.",
    },
  }[mode];
  return (
    <button
      type="button"
      onClick={onCycle}
      title={looks.title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition ${looks.cls}`}
    >
      <PencilLine size={11} />
      {looks.label}
    </button>
  );
}

/** One consent toggle chip. `on` styling stays quiet; `off` goes amber so a
 *  disabled capability is visibly non-default. */
function ConsentToggle({
  on,
  onToggle,
  icon,
  label,
  title,
}: {
  on: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title={title}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition " +
        (on
          ? "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:border-cobble-400"
          : "border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400")
      }
    >
      {icon}
      {label}
      <span
        className={
          "ml-0.5 inline-block h-3 w-6 rounded-full relative transition-colors " +
          (on ? "bg-cobble-600" : "bg-slate-300 dark:bg-slate-600")
        }
      >
        <span
          className={
            "absolute top-[1px] h-2.5 w-2.5 rounded-full bg-white transition-all " +
            (on ? "left-[13px]" : "left-[1px]")
          }
        />
      </span>
    </button>
  );
}

/** The Ask-Cobb button alone — safe to render in as many chrome spots as the
 *  layout needs (desktop header, mobile header, sidebar row). The conversation
 *  lives in the ONE <ChatPanel> AppLayout mounts; keeping the panel out of this
 *  component is the point. It used to be bundled in (one ChatWidget = button +
 *  panel), and because the panel PORTALS to <body>, the wrappers' hidden /
 *  md:hidden gating hid only the buttons — every mounted instance's panel
 *  rendered when the shared `open` flipped, stacked, each holding its own
 *  conversation. You typed into whichever was on top; a breakpoint resize
 *  changed which one that was. */
export function ChatLauncher({ open, setOpen, asRow = false }: { open: boolean; setOpen: (v: boolean) => void; asRow?: boolean }) {
  const { activeSlug } = useActiveOrg();
  if (!activeSlug) return null;
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={asRow ? "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition" : "transition p-1.5 text-faint dark:text-slate-500 hover:text-accent"}
      title={open ? "Hide Cobb" : "Ask Cobb"}
      aria-label={open ? "Hide Cobb" : "Ask Cobb"}
    >
      {/* A button labelled "Ask Cobb" should show Cobb, not a sparkle. The head
          is the mark drawn for this size — full-body is unreadable at 18px, and
          it stays lit even when AI is off, because basic mode still answers. */}
      <CobbHead size={18} className="shrink-0" title="Cobb" />
      {asRow && <span>Ask Cobb</span>}
    </button>
  );
}

/** The conversation panel. Mounted ONCE (AppLayout), not per launcher: it stays
 *  mounted while closed so the conversation survives close/reopen, and being
 *  the only instance is what guarantees one conversation, one portal, one
 *  prefs fetch, one cobblr:open-chat listener. `open`/`setOpen` are lifted to
 *  AppLayout so the main content can shift left when the panel opens. */
export function ChatPanel({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const detailRoute = useDetailRoute(activeSlug ?? "");
  const aiStatus = useAiStatus();
  const aiOff = !!aiStatus && !aiStatus.available;
  // Tool consent (per-user, per-workspace, enforced server-side): may Cobb read
  // your records into prompts / propose changes? Only fetched when the panel is
  // open and AI is on. Optimistic toggle.
  const qc = useQueryClient();
  const prefsQ = useQuery({
    queryKey: ["ai-chat-prefs", activeSlug],
    queryFn: () => api.aiChatPrefs(activeSlug),
    enabled: open && !!activeSlug && !aiOff,
    staleTime: 60_000,
  });
  const prefs = prefsQ.data ?? { read_tools: true, write_mode: "ask" as const };
  const setPrefs = useMutation({
    mutationFn: (p: { read_tools: boolean; write_mode: "off" | "ask" | "auto" }) => api.aiChatSetPrefs(activeSlug, p),
    onMutate: (p) => qc.setQueryData(["ai-chat-prefs", activeSlug], p),
    onError: () => void qc.invalidateQueries({ queryKey: ["ai-chat-prefs", activeSlug] }),
  });
  const undoMut = useMutation({
    mutationFn: (writeId: string) => api.aiChatUndo(activeSlug, writeId),
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  // Always-current view for code that runs outside the render (the mount
  // effect that resubscribes to an open turn).
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const [input, setInput] = useState("");
  // Deep-link seam: any surface can open the chat with GUIDANCE
  // (window.dispatchEvent(new CustomEvent("cobblr:open-chat", {detail:{seed|prefill|opener}}))).
  //   seed    — a PLACEHOLDER (ghost text saying what this conversation is for).
  //   prefill — a ready-to-go STARTER typed into the box for you, editable (legacy).
  //   opener  — a Cobb GREETING (an assistant turn) framing the screen you came
  //             from, what a modal's "Ask Cobb" button sends now. Preferred over
  //             prefill: it puts the words in Cobb's mouth, not the user's.
  // seed only shows while empty; prefill never clobbers text you've already typed.
  const [seedPlaceholder, setSeedPlaceholder] = useState<string | null>(null);
  // When the chat is opened programmatically for a NEW task (a modal's "Ask
  // Cobb", a deep-link) on top of an existing conversation, park the prior turns
  // behind a divider and scroll to it — the old chat isn't deleted, just scrolled
  // up out of the way (scroll back up to read it). `sessionStart` is the message
  // index where the current session begins; null = no divider.
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  // Live message count so the open-event listener (stable, empty-deps) reads the
  // length at fire time without going stale.
  const msgCountRef = useRef(0);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ seed?: string; prefill?: string; opener?: string }>).detail ?? {};
      setOpen(true);
      if (d.seed) setSeedPlaceholder(d.seed);
      if (d.prefill) setInput((cur) => (cur.trim() ? cur : d.prefill!));
      // Park whatever's already there behind a divider for this fresh task.
      setSessionStart(msgCountRef.current > 0 ? msgCountRef.current : null);
      // A Cobb OPENER: a canned greeting that frames the screen you came from,
      // added as an assistant turn below the divider. It tells you what Cobb can
      // do here AND grounds the model for your reply (it's part of the chat context).
      if (d.opener) setMessages((cur) => [...cur, { role: "assistant", content: d.opener! }]);
    };
    window.addEventListener("cobblr:open-chat", onOpen);
    return () => window.removeEventListener("cobblr:open-chat", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // DEV ONLY — which Cobb pose this panel draws. Cobb normally only reaches
  // `working`/`tada` by way of a real AI build, so there is otherwise no way to
  // see those poses in situ (at their real size, against the real panel, in the
  // theme you're running). Clicking him in the header cycles. `import.meta.env.DEV`
  // is a literal `false` in a production build, so the control and this state's
  // only writer are eliminated there and Cobb stays `idle` for users.
  const [devPose, setDevPose] = useState<CobbPose>("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);
  // Keep the count the open-listener reads in sync with what's rendered.
  useEffect(() => {
    msgCountRef.current = messages.length;
  }, [messages]);
  // On a fresh-task open, bring the session divider to the top so the prior
  // history scrolls up out of the way (still there — scroll back up). Before
  // paint, so there's no flash of the old scroll position.
  useLayoutEffect(() => {
    if (sessionStart != null && open) dividerRef.current?.scrollIntoView({ block: "start" });
  }, [sessionStart, open]);

  // Auto-grow the input with its content (up to a cap), then shrink back.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input, open]);

  // ── Per-workspace history cache (survives a page refresh) ──────────────────
  // Tracks which workspace the in-state `messages` belong to. The PERSIST effect
  // is intentionally defined BEFORE the LOAD effect: on a workspace switch both
  // fire in the same flush, and effects run in definition order — so persist
  // runs first, sees the OLD slug in this ref, and skips, instead of writing the
  // previous workspace's messages under the new workspace's key.
  const msgsSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (msgsSlugRef.current !== (activeSlug ?? null)) return; // messages not yet reloaded for this slug
    const key = chatStoreKey(activeSlug);
    if (!key) return;
    try {
      const slim = messages
        .filter((m) => m.content && m.content.trim())
        .slice(-CHAT_STORE_MAX)
        .map((m) => ({ role: m.role, content: m.content }));
      if (slim.length) localStorage.setItem(key, JSON.stringify(slim));
      else localStorage.removeItem(key);
    } catch {
      /* quota exceeded / storage disabled — history just won't persist */
    }
  }, [messages, activeSlug]);
  useEffect(() => {
    const key = chatStoreKey(activeSlug);
    let loaded: Msg[] = [];
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        if (Array.isArray(parsed)) loaded = parsed as Msg[];
      } catch {
        loaded = [];
      }
    }
    msgsSlugRef.current = activeSlug ?? null;
    setMessages(loaded);
    setSessionStart(null); // a different workspace's history — the old index is meaningless
  }, [activeSlug]);

  function clearChat() {
    setMessages([]);
    setError(null);
    setSessionStart(null);
    const key = chatStoreKey(activeSlug);
    if (key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }

  /** Turn one chat response into messages. Shared by the legacy blocking
   *  path and the persisted-turn path, so a reply renders identically
   *  however it arrived. */
  function applyResponse(next: Msg[], r: AiChatResponse) {
    if (r.type === "build-proposal" && r.building && r.draft_id) {
      // The build runs async (~150s). Show a "designing…" message and poll
      // the draft until it's ready, then swap in the preview + confirm.
      const draftId = r.draft_id;
      setMessages([
        ...next,
        { role: "assistant", content: r.summary ?? "Designing your workspace…", building: true, buildDraftId: draftId },
      ]);
      void pollBuild(draftId);
    } else {
      // AUTO mode: writes already applied this turn — one "✓ done" card each,
      // with an Undo where the ledger says it's reversible.
      if ((r.applied ?? []).length > 0) {
        window.dispatchEvent(new CustomEvent("cobblr:workspace-changed", { detail: { via: "cobb" } }));
      }
      // Tier-1.5 escort: Cobb walks the user to a screen he cannot operate
      // (members, tokens, backup, …). Navigation only — the page reads any
      // prefill.* params, and the page's own submit stays the user's. The
      // chat panel is docked, so the conversation survives the move. If the
      // model asked for several, the last one wins (one screen at a time).
      const escortTo = (r.escorts ?? []).at(-1);
      if (escortTo?.path?.startsWith("/")) navigate(escortTo.path);
      const doneCards: Msg[] = (r.applied ?? []).map((a) => ({
        role: "assistant" as const,
        content: a.summary,
        resolved: true,
        ledgerId: a.ledger_id,
        undoable: a.undoable,
      }));
      if (r.type === "proposal" && r.proposal) {
        setMessages([
          ...next,
          ...doneCards,
          // The loop may say something useful before proposing ("found 3 skeins
          // that match — want me to add the pattern?"): keep that text.
          ...(r.text ? [{ role: "assistant" as const, content: r.text }] : []),
          { role: "assistant", content: r.summary ?? "I can do that — confirm?", proposal: r.proposal },
        ]);
      } else if (r.type === "proposals" && r.items?.length) {
        // Several writes from one turn — one confirmable card each, so the user
        // approves or skips them individually.
        setMessages([
          ...next,
          ...doneCards,
          ...(r.text ? [{ role: "assistant" as const, content: r.text }] : []),
          ...r.items.map((it) => ({
            role: "assistant" as const,
            content: it.summary,
            proposal: it.proposal,
          })),
        ]);
      } else {
        setMessages([...next, ...doneCards, { role: "assistant", content: r.text ?? "(no response)" }]);
      }
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setSeedPlaceholder(null);
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);

    // No AI provider → ask the server's basic-mode matcher (no model, no cost)
    // instead of hitting the AI chat only to render a failure. The endpoint
    // always returns a reply (its own graceful no-match nudge); the fallback
    // below only fires if the endpoint itself is unreachable.
    if (aiOff) {
      setBusy(true);
      try {
        const r = await api.answerBasic(activeSlug, text);
        setMessages([...next, { role: "assistant", content: r.reply }]);
      } catch {
        setMessages([...next, { role: "assistant", content: BASIC_FALLBACK }]);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      // Start a PERSISTED turn and follow it, rather than holding one request
      // open for the whole loop. The turn lives server-side: progress streams
      // in as it happens, a refresh resubscribes to the same id, and a second
      // tab of the same workspace sees it too (see followTurn + the on-open
      // check in the mount effect).
      const started = await api.aiChatStart(
        activeSlug,
        next.map((m) => ({ role: m.role, content: m.content })),
        getChatPageContext() ?? undefined,
      );
      rememberOpenTurn(started.turn_id);
      await followTurn(started.turn_id, next);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Something went wrong.";
      setError(/no provider|not entitled|not available|no_ai/i.test(msg) ? "AI isn't enabled for this workspace yet." : msg);
      setBusy(false);
    }
  }

  // ── Following a persisted turn ────────────────────────────────────────────
  //
  // One turn id, three readers that all behave the same: the tab that started
  // it, a tab that refreshed mid-turn, and a second tab that opened the chat.
  // Progress events render as a live "working" line under the user's message;
  // the `done` event carries the same response the blocking POST used to
  // return and goes through applyResponse, so the final render is identical.

  const openTurnKey = () => `cobblr.chat.turn.${activeSlug}`;
  function rememberOpenTurn(id: string | null) {
    try {
      if (id) localStorage.setItem(openTurnKey(), id);
      else localStorage.removeItem(openTurnKey());
    } catch {
      /* private mode */
    }
  }

  const followingRef = useRef<{ id: string; abort: () => void } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  function describeEvent(kind: string, data: Record<string, unknown>): string | null {
    switch (kind) {
      case "thinking":
        return (data.round as number) > 0 ? "Thinking about what it found…" : "Thinking…";
      case "tool": {
        const name = String(data.name ?? "");
        const pretty = name.replace(/_/g, " ");
        return data.write ? `Making a change: ${pretty}…` : `Reading: ${pretty}…`;
      }
      case "tool-result":
        return data.ok ? null : "That didn't work, trying another way…";
      case "applied":
        return "Applied a change…";
      default:
        return null;
    }
  }

  async function followTurn(turnId: string, next: Msg[]) {
    // One follower at a time; a newer turn supersedes an older subscription.
    followingRef.current?.abort();
    setBusy(true);
    setProgress("Starting…");

    // Catch up first: if the turn already finished (a refresh that came back
    // late), there is nothing to stream — just render its result.
    try {
      const { turn } = await api.aiChatTurn(activeSlug, turnId);
      if (turn.status === "done" && turn.result) {
        finishFollow(next, turn.result);
        return;
      }
      if (turn.status === "failed") {
        failFollow(turn.error ?? "Something went wrong.");
        return;
      }
    } catch {
      /* fall through to the stream, which will 404 if it truly is gone */
    }

    const ac = new AbortController();
    followingRef.current = { id: turnId, abort: () => ac.abort() };
    let last = 0;
    let settled = false;

    const handle = (ev: { id: string | null; event: string; data: string }) => {
      if (settled) return;
      const seq = ev.id ? Number(ev.id) : NaN;
      if (Number.isFinite(seq)) last = Math.max(last, seq);
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      if (ev.event === "done") {
        settled = true;
        const result = (data as { result?: AiChatResponse }).result ?? null;
        if (result) finishFollow(next, result);
        else failFollow("The turn finished but sent no result.");
        return;
      }
      if (ev.event === "error") {
        settled = true;
        failFollow(String((data as { message?: string }).message ?? "Something went wrong."));
        return;
      }
      const line = describeEvent(ev.event, data);
      if (line) setProgress(line);
    };

    // Read the stream; on a transport drop, reconnect from the last seq we
    // saw. The server replays after=N, so nothing is missed either way.
    (async () => {
      let attempts = 0;
      while (!settled && !ac.signal.aborted && attempts < 20) {
        try {
          await readSse(api.aiChatTurnEventsUrl(activeSlug, turnId, last), handle, { signal: ac.signal });
          if (settled || ac.signal.aborted) break;
          // Stream ended without done/error: the server closed on a finished
          // turn we did not see finish. Read the row.
          const { turn } = await api.aiChatTurn(activeSlug, turnId);
          if (turn.status === "done" && turn.result) {
            settled = true;
            finishFollow(next, turn.result);
          } else if (turn.status === "failed") {
            settled = true;
            failFollow(turn.error ?? "Something went wrong.");
          }
          break;
        } catch (e) {
          if (ac.signal.aborted) break;
          attempts++;
          if (/no such turn|404/.test((e as Error).message)) {
            settled = true;
            failFollow("That conversation is no longer running.");
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(1000 * attempts, 5000)));
        }
      }
    })();
  }

  function finishFollow(next: Msg[], r: AiChatResponse) {
    rememberOpenTurn(null);
    setProgress(null);
    setBusy(false);
    applyResponse(next, r);
  }
  function failFollow(msg: string) {
    rememberOpenTurn(null);
    setProgress(null);
    setBusy(false);
    setError(/no provider|not entitled|not available|no_ai/i.test(msg) ? "AI isn't enabled for this workspace yet." : msg);
  }

  // On mount (and workspace change): is a turn already running for me? Two
  // sources, both cheap — the id this browser remembered, and the server's
  // own "open turn for this user" (which covers a turn started in another
  // tab or another browser). Either way, resubscribe rather than start blank.
  useEffect(() => {
    if (!activeSlug || aiOff) return;
    let cancelled = false;
    (async () => {
      let id: string | null = null;
      try {
        id = localStorage.getItem(openTurnKey());
      } catch {
        /* private mode */
      }
      if (!id) {
        try {
          id = (await api.aiChatOpenTurn(activeSlug)).turn?.id ?? null;
        } catch {
          /* no server-side turn */
        }
      }
      if (cancelled || !id) return;
      // Base the render on what this tab has, but make sure the turn's own
      // prompt is the last user message: a second tab that never sent it, or a
      // refresh that raced the history restore, would otherwise render the
      // reply under nothing.
      let base = messagesRef.current;
      try {
        const { turn } = await api.aiChatTurn(activeSlug, id);
        const lastUser = [...base].reverse().find((m) => m.role === "user");
        if (turn.prompt && lastUser?.content !== turn.prompt) {
          base = [...base, { role: "user", content: turn.prompt }];
          setMessages(base);
        }
      } catch {
        /* follow anyway; followTurn handles a vanished turn */
      }
      if (cancelled) return;
      await followTurn(id, base);
    })();
    // Another tab of this browser started (or finished) a turn: the
    // remembered id changes under us. Follow the new one; on clear, nothing to
    // do - our own follower will see `done`. This is what keeps two open tabs
    // showing the same in-progress state, not just the same final answer.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== openTurnKey() || cancelled) return;
      const next = e.newValue;
      if (next && next !== followingRef.current?.id) {
        void (async () => {
          let base = messagesRef.current;
          try {
            const { turn } = await api.aiChatTurn(activeSlug, next);
            const lastUser = [...base].reverse().find((m) => m.role === "user");
            if (turn.prompt && lastUser?.content !== turn.prompt) {
              base = [...base, { role: "user", content: turn.prompt }];
              setMessages(base);
            }
          } catch {
            return;
          }
          if (!cancelled) await followTurn(next, base);
        })();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      followingRef.current?.abort();
      followingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug, aiOff]);


  // Poll an async whole-workspace build until the draft leaves "building",
  // then swap the placeholder message for the preview + confirm (or an error).
  // Matches the message by buildDraftId so it survives new messages arriving.
  async function pollBuild(draftId: string) {
    const patch = (changes: Partial<Msg>) =>
      setMessages((prev) => prev.map((m) => (m.buildDraftId === draftId ? { ...m, ...changes } : m)));
    const started = Date.now();
    while (Date.now() - started < 330_000) {
      await new Promise((r) => setTimeout(r, 3000));
      let d;
      try {
        d = await api.authoringDraft(activeSlug, draftId);
      } catch {
        continue; // transient — keep polling
      }
      if (d.status === "building") continue;
      if (d.status === "validated" && d.validation?.preview) {
        const p = d.validation.preview;
        const adds = p.fields_added.length + p.wires_added.length + p.modules_to_enable.length;
        const seedCount = (d.seed_plan ?? []).reduce((n, g) => n + (g.records?.length ?? 0), 0);
        patch({
          building: false,
          content: d.interpretation ?? "Here's what I'll set up — confirm?",
          ...(adds > 0 ? { proposal: { kind: "build", draft_id: draftId }, buildPreview: p, buildSeedCount: seedCount } : {}),
        });
        return;
      }
      patch({
        building: false,
        content:
          d.status === "failed"
            ? "I couldn't set that up just now — mind trying again, or describe the main things you want to track?"
            : (d.interpretation ? d.interpretation + "\n\n" : "") +
              "I couldn't turn that into a clean setup automatically. Try describing the main things you want to track (one per line) and I'll try again.",
      });
      return;
    }
    patch({ building: false, content: "That took longer than expected. Try again in a moment." });
  }

  function markResolved(idx: number) {
    setMessages((prev) => prev.map((m, i) => (i === idx ? { ...m, resolved: true } : m)));
  }

  async function confirm(idx: number) {
    const m = messages[idx];
    if (!m?.proposal || busy) return;
    setBusy(true);
    try {
      const r = await api.aiChatExecute(activeSlug, m.proposal);
      markResolved(idx);
      if (r.ok) {
        // Anything open alongside the chat (the put-away plan, pickers) can
        // react — Cobb just changed the workspace.
        window.dispatchEvent(new CustomEvent("cobblr:workspace-changed", { detail: { via: "cobb" } }));
      }
      // The executed write carries its change-ledger id — the Undo handle.
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: (r.ok ? "✓ " : "✗ ") + r.message,
          ...(r.ok && r.ledger_id
            ? { resolved: true, ledgerId: r.ledger_id, undoable: r.undoable, entityKind: r.entity?.kind, entityId: r.entity?.id }
            : {}),
        },
      ]);
    } catch (e) {
      markResolved(idx);
      const msg = e instanceof ApiError ? e.message : "Couldn't do that.";
      setMessages((prev) => [...prev, { role: "assistant", content: "✗ " + msg }]);
    } finally {
      setBusy(false);
    }
  }

  function cancel(idx: number) {
    markResolved(idx);
    setMessages((prev) => [...prev, { role: "assistant", content: "Okay, left it alone." }]);
  }

  async function undoWrite(idx: number) {
    const m = messages[idx];
    if (!m?.ledgerId || m.undone || busy) return;
    try {
      const r = await undoMut.mutateAsync(m.ledgerId);
      setMessages((prev) => {
        const copy = [...prev];
        if (copy[idx]) copy[idx] = { ...copy[idx]!, undone: r.ok };
        return [...copy, { role: "assistant", content: (r.ok ? "↩ " : "✗ ") + r.message }];
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Couldn't undo that.";
      setMessages((prev) => [...prev, { role: "assistant", content: "✗ " + msg }]);
    }
  }

  // The line that separates a parked earlier conversation (above it, scrolled
  // out of view on open) from the current session (below). Rendered exactly once
  // — at the session boundary — so its ref is unambiguous for the open-scroll.
  const sessionDivider = (
    <div ref={dividerRef} className="relative py-2 select-none" aria-hidden="true">
      <div className="border-t border-line dark:border-slate-700" />
      <span className="absolute left-1/2 -translate-x-1/2 -top-2 bg-surface dark:bg-slate-900 px-2 text-[10px] font-medium uppercase tracking-wider text-faint dark:text-slate-500">
        ↑ Earlier
      </span>
    </div>
  );

  if (!activeSlug || !open) return null;

  return (
    <SidePanel width="sm:w-[min(100vw,440px)]" escapeExempt>
          <header className="flex items-center justify-between px-4 py-3 border-b border-line dark:border-slate-700 shrink-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-content dark:text-mortar-100">
              {/* The bust is always the wave — it takes no pose (see CobbBust).
                  In dev this is also the pose-cycler button, but what it cycles is
                  the FULL-BODY Cobb below, which is where poses are reviewable. */}
              {import.meta.env.DEV ? (
                <button
                  type="button"
                  onClick={() => setDevPose((p) => COBB_POSES[(COBB_POSES.indexOf(p) + 1) % COBB_POSES.length]!)}
                  title={`Cobb — cycle the full-body pose below: ${devPose} (dev only)`}
                  className="rounded hover:bg-subtle/60 dark:hover:bg-slate-800/60 transition"
                >
                  <CobbBust size={42} title="Cobb" className="cobb-lift" />
                </button>
              ) : (
                <CobbBust size={42} title="Cobb" className="cobb-lift" />
              )}
              Ask Cobb
              {import.meta.env.DEV && (
                <span className="font-mono text-[10px] font-normal text-faint">{devPose}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={clearChat}
                  className="text-faint hover:text-content dark:hover:text-mortar-200 transition p-1"
                  aria-label="Clear conversation"
                  title="Clear this conversation"
                >
                  <Trash2 size={15} />
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} className="text-faint hover:text-content dark:hover:text-mortar-200 transition" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </header>

          {/* Tool consent, always visible while AI is on: since the agent loop,
              Cobb READS records into prompts (and with a shared AI that data
              transits another member's connection) — so both capabilities are
              user-switchable right where they act. Enforced server-side. */}
          {!aiOff && (
            <div className="px-4 pt-2 pb-1 shrink-0 flex items-center gap-2 flex-wrap">
              <ConsentToggle
                on={prefs.read_tools}
                onToggle={() => setPrefs.mutate({ ...prefs, read_tools: !prefs.read_tools })}
                icon={<Eye size={11} />}
                label="Read my data"
                title="Let Cobb search and read this workspace's records to answer questions. Record data is sent to the workspace's AI provider."
              />
              {/* Claude-Code-style write mode, cycled by click: Ask → Auto → Off.
                  Auto = record changes apply immediately (every one ledgered +
                  undoable); ACTIONS still ask — they can be irreversible. */}
              <WriteModeChip
                mode={prefs.write_mode}
                onCycle={() =>
                  setPrefs.mutate({
                    ...prefs,
                    write_mode: prefs.write_mode === "ask" ? "auto" : prefs.write_mode === "auto" ? "off" : "ask",
                  })
                }
              />
            </div>
          )}

          {/* Up-front, before-you-type: if AI is off, say so now (with a connect
              path) instead of failing after the first message. Pinned below the
              header so it's the first thing you see on open. */}
          {aiOff && (
            <div className="px-4 pt-3 shrink-0">
              <AiOffNotice status={aiStatus} compact>
                <strong>AI chat isn't connected - Cobb's in basic mode.</strong> I can
                help you find your way around, but I can't search your workspace or make
                changes yet.{" "}
              </AiOffNotice>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="mt-6 px-4 flex flex-col items-center text-center">
                <Cobb pose={devPose} size={150} title="Cobb" className="cobb-lift" />
                <p className="text-xs text-faint dark:text-slate-500 leading-relaxed mt-2">
                  {aiOff ? (
                    <>Ask me the basics - "what can you do", "how do I add a part", "where do I scan". For
                    questions about your actual data or to have me make changes, connect AI up top.</>
                  ) : (
                    // The last line must match the write-mode chip: "I'll check
                    // with you" is only true in ASK mode — in AUTO, changes apply
                    // as we go; in OFF, nothing changes (reported 2026-07-11).
                    <>Ask about your workspace, or tell me to do something - "add a part called Widget", "what's low on
                    stock?".{" "}{{
                      ask: "I'll check with you before I change anything.",
                      auto: "Changes apply as we go, and every one is tracked so you can undo it.",
                      off: "I won't make any changes right now, just ask me things.",
                    }[prefs.write_mode]}</>
                  )}
                </p>
              </div>
            )}
            {/* DEV ONLY — the big Cobb normally lives in the empty state, so he
                vanishes the moment a conversation starts and you can no longer
                see the pose you're reviewing. While a non-idle pose is selected,
                keep him pinned above the turns. Idle behaves exactly like prod. */}
            {import.meta.env.DEV && messages.length > 0 && devPose !== "idle" && (
              <div className="flex flex-col items-center border-b border-dashed border-line dark:border-slate-700 pb-3">
                <Cobb pose={devPose} size={150} title={`Cobb ${devPose}`} className="cobb-lift" />
                <span className="font-mono text-[10px] text-faint mt-1">dev preview · {devPose}</span>
              </div>
            )}
            {messages.map((m, i) => {
              const el =
              m.role === "user" ? (
                <div key={i} className="text-right">
                  <div className="inline-block max-w-[88%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-cobble-600 text-white text-left">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="text-left">
                  <div className="prose prose-sm dark:prose-invert max-w-none text-content dark:text-mortar-100 prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 break-words">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                  {/* A workspace build running in the background — the longest
                      wait in the product, and the most literal `working`. */}
                  {m.building && (
                    <div className="mt-1 flex items-center gap-2 text-xs text-faint dark:text-slate-500">
                      <Cobb pose="working" size={52} title="Cobb, at work" className="cobb-lift shrink-0" />
                      Turning on modules and building your fields - this takes a minute or two…
                    </div>
                  )}
                  {/* He built it and is holding it out for you to check before it
                      lands — the same beat (and the same pose) the Build page
                      uses for "Built it. Verified it." */}
                  {m.buildPreview && !m.resolved && (
                    <div className="mt-2 flex items-start gap-2">
                      <Cobb pose="tada" size={48} title="Cobb presents the build" className="cobb-lift shrink-0" />
                      <div className="flex-1 min-w-0 rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/60 px-3 py-2 text-xs space-y-1.5">
                      {m.buildPreview.modules_to_enable.length > 0 && (
                        <div className="text-content dark:text-mortar-100">
                          <span className="text-faint">Turns on:</span> {m.buildPreview.modules_to_enable.join(", ")}
                        </div>
                      )}
                      {m.buildPreview.fields_added.length > 0 && (
                        <div>
                          <span className="text-faint">Adds {m.buildPreview.fields_added.length} field{m.buildPreview.fields_added.length === 1 ? "" : "s"}:</span>{" "}
                          {m.buildPreview.fields_added
                            .slice(0, 8)
                            .map((f) => `${f.display_label} (${kindLabel(f.entity_kind)})`)
                            .join(", ")}
                          {m.buildPreview.fields_added.length > 8 ? ", …" : ""}
                        </div>
                      )}
                      {m.buildPreview.wires_added.length > 0 && (
                        <div className="text-faint">
                          Adds {m.buildPreview.wires_added.length} automation{m.buildPreview.wires_added.length === 1 ? "" : "s"}
                        </div>
                      )}
                      {!!m.buildSeedCount && m.buildSeedCount > 0 && (
                        <div className="text-content dark:text-mortar-100">
                          <span className="text-faint">Creates:</span> {m.buildSeedCount} starter record{m.buildSeedCount === 1 ? "" : "s"}
                        </div>
                      )}
                      </div>
                    </div>
                  )}
                  {/* He's proposing a change and waiting on your call — the
                      suggestion moment the `idea` pose was drawn for. Only while
                      it's unresolved: once you decide, he stops asking. */}
                  {m.proposal && !m.resolved && (
                    <div className="mt-2 flex items-center gap-2">
                      <Cobb pose="idea" size={44} title="Cobb suggests" className="cobb-lift shrink-0" />
                      <button
                        type="button"
                        onClick={() => void confirm(i)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                      >
                        <Check size={13} /> {m.proposal.kind === "build" ? "Set it up" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        onClick={() => cancel(i)}
                        disabled={busy}
                        className="rounded-md border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {/* Take-me-there: after a create, offer a jump to the new
                      record instead of leaving the user to go hunt for it. Only
                      when the entity kind has a detail route. */}
                  {(() => {
                    const to = m.entityKind && m.entityId ? detailRoute(m.entityKind, m.entityId) : null;
                    return to ? (
                      <div className="mt-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            navigate(to);
                          }}
                          className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-[11px] font-medium px-2.5 py-0.5 transition"
                        >
                          View it →
                        </button>
                      </div>
                    ) : null;
                  })()}
                  {/* An EXECUTED write (confirmed or auto-applied): the change-
                      ledger makes it reversible — Undo restores the before-image
                      (a recreated delete gets a new id, said honestly). */}
                  {m.ledgerId && m.undoable && !m.undone && (
                    <div className="mt-1.5">
                      <button
                        type="button"
                        onClick={() => void undoWrite(i)}
                        disabled={undoMut.isPending}
                        className="rounded-md border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-ember-500 hover:border-ember-400 text-[11px] font-medium px-2 py-0.5 transition disabled:opacity-50"
                      >
                        ↩ Undo
                      </button>
                    </div>
                  )}
                  {m.undone && <div className="mt-1 text-[11px] text-faint">↩ undone</div>}
                </div>
              );
              // Drop the session divider in front of the first message of the
              // current session; the parked earlier turns render above it.
              return sessionStart != null && i === sessionStart ? (
                <div key={i}>
                  {sessionDivider}
                  {el}
                </div>
              ) : (
                el
              );
            })}
            {/* Fresh session opened with nothing new typed yet — the divider
                trails the parked history, and a spacer below gives it room to pin
                to the top so the old conversation fully scrolls out of view (the
                first reply fills the space). */}
            {sessionStart != null && sessionStart === messages.length && messages.length > 0 && (
              <>
                {sessionDivider}
                <div className="min-h-[70dvh] shrink-0" aria-hidden="true" />
              </>
            )}
            {/* Waiting on a reply. Cobb's poses are STATES, not decoration, so
                the wait is where `working` belongs: he's at the bench while you
                wait, instead of a generic dot. Deliberately small and static —
                he shows up because something is happening, and leaves when it
                stops. */}
            {busy && (
              <div className="flex items-center gap-3">
                <Cobb pose="working" size={52} title="Cobb, at work" className="cobb-lift shrink-0" />
                {/* The "…" is HIS speech bubble (tail pointing back at him), not
                    a widget that happens to sit nearby — same device as the
                    Build greeting, in miniature. */}
                {/* What he is doing, not just that he is doing something. The
                    persisted turn streams progress ("Reading: list records…"),
                    so a 90-second turn reads as work rather than as a hang.
                    Falls back to "…" for the first instant before the first
                    event and for the basic (no-AI) path. */}
                <div className="cobb-bubble cobb-bubble-sm relative rounded-lg px-3 py-2 bg-subtle dark:bg-slate-800 text-faint text-sm" aria-live="polite">
                  {progress ?? "…"}
                </div>
              </div>
            )}
            {error && (
              <div className="text-xs text-ember-500 bg-ember-50 dark:bg-ember-900/20 rounded px-3 py-2">{error}</div>
            )}
          </div>

          <div className="border-t border-line dark:border-slate-700 p-3 flex items-end gap-2 shrink-0">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={seedPlaceholder ?? "Ask or tell me to do something… (Shift+Enter for a new line)"}
              // text-base (16px) on mobile so iOS Safari doesn't auto-zoom the
              // page on focus (any input <16px triggers the zoom, which then
              // strands you zoomed-in + cut off). sm:text-sm keeps the desktop look.
              className="flex-1 resize-none px-3 py-2 text-base sm:text-sm rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-200 leading-relaxed"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || busy}
              className="h-9 w-9 shrink-0 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white flex items-center justify-center transition disabled:opacity-50"
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          </div>
    </SidePanel>
  );
}
