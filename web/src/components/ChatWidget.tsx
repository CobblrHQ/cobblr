// Floating AI chat — bottom-right launcher → RIGHT SIDEBAR. Agentic: the
// assistant chats AND can DO things — it proposes a create/action the user
// CONFIRMS before it runs (core-ai /chat → proposal → /chat/execute). Assistant
// messages render markdown; the input auto-grows. Portals to <body> so the
// header's backdrop-blur can't trap its position:fixed (CLAUDE.md modal note).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Send, Check, Eye, PencilLine, Trash2, Wand2 } from "lucide-react";
import { api, ApiError, type AiChatProposal, type AiChatResponse, type BasicCommandOffer, type BundleValidationPreview } from "../lib/api";
import { readSse } from "../lib/sse";
import { Cobb, CobbBust, CobbHead, COBB_POSES, type CobbPose } from "./Cobb";
import { useNavigate } from "react-router-dom";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { getChatPageContext, getChatSelection, clearChatSelection, useChatSelection } from "../lib/chat-context";
import { useSelectionCapture } from "../lib/use-selection-capture";
import { localAnswerFor } from "../lib/local-answers";
import { describeTool } from "../lib/chat-progress";
import {
  caretOnFirstLine,
  caretOnLastLine,
  emptyHistory,
  loadHistory,
  recallNewer,
  recallOlder,
  remember,
  saveHistory,
  stopBrowsing,
  type HistoryState,
} from "../lib/input-history";
import { useDetailRoute } from "../lib/useDetailRoute";
import { useAiStatus, AiOffNotice } from "./AiStatusNotice";
import { RailTabContent, openRail, useRailActiveTab, useRailTab } from "./SideRail";

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
  /** What was in context when this was SENT. A message reads differently once
   *  you have scrolled back to it — "tell me about these" is meaningless
   *  without the two racks it came with — so the message keeps its own copy
   *  rather than borrowing whatever the composer holds now. */
  sentWith?: { label: string; kind?: string; ids?: string[]; text?: string };
  proposal?: AiChatProposal; // assistant proposed a write — needs confirm
  buildPreview?: BundleValidationPreview; // build-proposal: what applying enables/adds
  buildSeedCount?: number; // build-proposal: starter records apply will create
  building?: boolean; // a whole-workspace build is running in the background (poll)
  buildDraftId?: string; // matches the polled draft (stable across new messages)
  resolved?: boolean; // proposal confirmed or cancelled
  ledgerId?: string; // an EXECUTED write's change-ledger row — the Undo handle
  /** A bulk write made many rows. One card, one Undo, every handle pressed. */
  ledgerIds?: string[];
  /** The instruction those rows came from. Undoing names THIS, so the server
   *  puts the whole thing back in one request instead of the client posting
   *  sixty ids it happens to be holding. */
  undoTurnId?: string;
  /** An undo that stopped short, and the instruction it stopped short of.
   *  Offering the rest is a second press by a person who has been told what is
   *  in the way — the undo itself never decides to go through. */
  offerForceTurnId?: string;
  offerForceCount?: number;
  undoable?: boolean;
  undone?: boolean; // this write was undone from the chat
  /** The learned command this result message came from, kept so a later
   *  "do that again" can name it (see the prior sent with answerBasic). */
  ranCommand?: { id: string; message: string };
  entityKind?: string; // an executed CREATE's entity — powers a "View it" link
  entityId?: string;
  /** A learned command that fits what was typed, offered for confirmation. The
   *  message rides along because the SERVER re-binds it: the browser never
   *  sends the operations, only what the user said. */
  command?: { id: string; template: string; operations: number; summary: string; message: string };
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
  // ABOVE the guard. React identifies hooks by call order, so a hook below an
  // early return runs only on some renders — the crash this repo already has a
  // lint for, which is what caught it here.
  const activeTab = useRailActiveTab();
  if (!activeSlug) return null;

  // OPENING goes through openRail so it lands on the tab the words name.
  // Toggling the shared `open` flag alone reopens whatever tab was last used,
  // so a control labelled "Ask Cobb" could open on Pinned — which is exactly
  // what it did once the rail grew tabs.
  // ONE RULE FOR EVERY SEGMENT:
  //
  //   closed                → open on my tab
  //   open, showing my tab  → close
  //   open, showing another → SWITCH to my tab
  //
  // The third case is the one that was missing, and it made the row feel
  // broken in both directions: pressing Cobb while Discussion was showing
  // closed the panel (because "open" was read as "mine"), and pressing
  // Discussion while Discussion was showing did nothing (because it always
  // called openRail).
  const go = (tab: string) => () => {
    if (open && activeTab === tab) setOpen(false);
    else openRail(tab);
  };
  const openCobb = go("cobb");

  // ── the header form: an icon, and Cobb is what it opens ─────────────
  if (!asRow) {
    return (
      <button
        type="button"
        onClick={openCobb}
        className="transition p-1.5 text-faint dark:text-slate-500 hover:text-accent"
        title={open ? "Hide Cobb" : "Ask Cobb"}
        aria-label={open ? "Hide Cobb" : "Ask Cobb"}
      >
        {/* A button labelled "Ask Cobb" should show Cobb, not a sparkle. The
            head is the mark drawn for this size — full-body is unreadable at
            18px, and it stays lit even when AI is off, because basic mode
            still answers. */}
        <CobbHead size={18} className="shrink-0" title="Cobb" />
      </button>
    );
  }

  // ── the menu form: ONE row, two ways in ─────────────────────────────
  //
  // Cobb and Discussion are two rooms behind the same door, so they share a
  // row rather than taking one each — the menu is short, and a row apiece
  // would teach that they are separate destinations when they are not. It also
  // stops "Ask Cobb" having to cover for a panel that does more than Cobb,
  // which is what made the name look wrong.
  //
  // A div of two buttons, not a button with two halves: a button inside a
  // button is invalid, and each half genuinely does its own thing.
  // gap-1.5, not 2.5: the sidebar column is 208px and "Ask Cobb | Discussion"
  // only just fits. At 2.5, with the divider's own padding, it overran and
  // "Ask Cobb" wrapped onto two lines — which reads as a mistake rather than a
  // pair. whitespace-nowrap on both halves keeps that from coming back when a
  // label changes.
  return (
    <div className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition">
      <CobbHead size={18} className="shrink-0" title="Cobb" />
      <button
        type="button"
        onClick={openCobb}
        className="whitespace-nowrap hover:text-accent transition"
        title={open ? "Hide Cobb" : "Ask Cobb"}
        aria-label={open ? "Hide Cobb" : "Ask Cobb"}
      >
        Ask Cobb
      </button>
      {/* The divider is a TARGET too: it opens the panel on whatever you had
          last, which is what you want when you do not care which room — you
          just want the thing back. Air on both sides so at 13px it reads as
          the join between two controls rather than punctuation inside one
          phrase. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="px-1.5 text-faint/60 dark:text-slate-600 hover:text-accent select-none transition"
        title={open ? "Hide the panel" : "Reopen the panel where you left it"}
        aria-label={open ? "Hide the panel" : "Reopen the panel"}
      >
        |
      </button>
      <button
        type="button"
        onClick={go("discussion")}
        className="whitespace-nowrap hover:text-accent transition"
        title="What people are saying here"
        aria-label="Open discussion"
      >
        Discussion
      </button>
    </div>
  );
}

/** The conversation panel. Mounted ONCE (AppLayout), not per launcher: it stays
 *  mounted while closed so the conversation survives close/reopen, and being
 *  the only instance is what guarantees one conversation, one portal, one
 *  prefs fetch, one cobblr:open-chat listener. `open`/`setOpen` are lifted to
 *  AppLayout so the main content can shift left when the panel opens. */
export function ChatPanel({ open: railOpen, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  // Registers Cobb as a rail tab and reports whether he is the one SHOWING.
  // Everything below gates on `open` meaning "this tab is visible" — the rail
  // being open on a different tab must not leave Cobb polling, subscribing or
  // capturing selection in the background.
  const { active: open } = useRailTab({
    id: "cobb",
    label: "Cobb",
    icon: <CobbBust size={18} title="" />,
    order: 0,
  });
  void railOpen;
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
  // Opening the chat FOR something (a row's Cobb button, a modal, a deep-link)
  // used to park the prior turns behind an "↑ Earlier" divider, with a 70dvh
  // spacer under it, and scroll the divider to the top. Three separate things
  // moved the view for a person who had only pressed a button beside a rack.
  //
  // What they pressed says all of it already: the chip above the box reads
  // "About: Rack 12". So the context is a property of the NEXT message, shown
  // where the next message is typed, and the conversation stays exactly where
  // it was.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ seed?: string; prefill?: string; opener?: string }>).detail ?? {};
      setOpen(true);
      if (d.seed) setSeedPlaceholder(d.seed);
      if (d.prefill) setInput((cur) => (cur.trim() ? cur : d.prefill!));
      // A Cobb OPENER: a canned greeting that frames the screen you came from,
      // added as an assistant turn. It tells you what Cobb can do here AND
      // grounds the model for your reply (it's part of the chat context).
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
  // Mirrored into STATE as well, so the sizing effect below re-runs the moment
  // the textarea actually attaches. A plain ref cannot do that: it mutates
  // without a render, and since the panel became a portalled rail tab the
  // element mounts a render LATER than `open` flips — so the effect fired once
  // against a null ref, bailed, and never ran again. The composer stayed one
  // row tall with its placeholder clipped (caught by an A/B screenshot, not by
  // typecheck).
  const [taEl, setTaEl] = useState<HTMLTextAreaElement | null>(null);
  const setTa = useCallback((el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    setTaEl(el);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  // Auto-grow the input with its content (up to a cap), then shrink back — and
  // place the caret at the end of a message just recalled from history.
  //
  // Both belong in the SAME layout effect, and the caret cannot be deferred to
  // a requestAnimationFrame: a fast typist (or Playwright) gets a character in
  // before the frame runs, and the queued setSelectionRange then yanks the
  // caret back behind it. That produced "third thingplus more " from a recall
  // followed by typing " plus more" — the space landed last. A layout effect
  // runs synchronously with the commit that rendered the new value, so there is
  // no window to type into.
  const caretToEndRef = useRef(false);
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    if (caretToEndRef.current) {
      caretToEndRef.current = false;
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [input, open, taEl]);

  // ── Up/Down recall of what you sent ───────────────────────────────────────
  // Its own store, not the conversation cache: clearing the chat clears what
  // was SAID and should not also forget what you TYPED, the same way a shell's
  // history outlives `clear`.
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  useEffect(() => {
    setHistory({ entries: loadHistory(activeSlug), index: null, draft: "" });
  }, [activeSlug]);

  /** Put the caret at the end of a recalled message, as a shell does — you are
   *  almost always about to add to it or resend it, never to edit its start.
   *  The move itself happens in the layout effect above; see the race there. */
  function showRecalled(value: string) {
    caretToEndRef.current = true;
    setInput(value);
  }

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
        .map((m) => ({ role: m.role, content: m.content, ...(m.sentWith ? { sentWith: m.sentWith } : {}) }));
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
  }, [activeSlug]);

  /** Cobb changed the workspace: tell the app, and make the screens behind the
   *  panel actually show it.
   *
   *  Dispatching the event alone was not enough — one component listens to it,
   *  and every list on screen is a cached query that has no idea anything
   *  happened. So a rack whose duplicate shelves Cobb had just deleted still
   *  showed them, which reads as "it did not work" and is worse than the
   *  original problem. Invalidating refetches only what is on screen. */
  function workspaceChanged() {
    window.dispatchEvent(new CustomEvent("cobblr:workspace-changed", { detail: { via: "cobb" } }));
    void qc.invalidateQueries();
  }

  function clearChat() {
    setMessages([]);
    setError(null);
    // A new conversation starts on nothing in particular. (Sending does NOT do
    // this — the context belongs to the conversation, not to one message.)
    clearChatSelection();
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
        workspaceChanged();
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

  /** Run a learned command the user just confirmed. The server binds the
   *  message against the stored pattern and writes through the same ledger an
   *  AI write uses, so it is recorded and undoable in the usual way. */
  async function runCommand(i: number) {
    const m = messages[i];
    if (!m?.command || busy) return;
    setBusy(true);
    try {
      const out = await api.runCommand(activeSlug, m.command.id, m.command.message, getChatSelection()?.ids);
      if (out.ok) workspaceChanged();
      setMessages((prev) => {
        const copy = [...prev];
        const at = copy[i];
        if (at) copy[i] = { ...at, resolved: true };
        return [...copy, {
          role: "assistant",
          content: (out.ok ? "✓ " : "✗ ") + out.message,
          // Kept so "do that again" and "undo" can point here later.
          ...(out.ok ? { ranCommand: { id: m.command!.id, message: m.command!.message } } : {}),
          ...(out.ledger_ids?.length ? { resolved: true, ledgerIds: out.ledger_ids, undoable: true } : {}),
        }];
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "That didn't work.";
      setMessages((prev) => {
        const copy = [...prev];
        const at = copy[i];
        if (at) copy[i] = { ...at, resolved: true };
        return [...copy, { role: "assistant", content: `✗ ${msg}` }];
      });
    } finally {
      setBusy(false);
    }
  }

  // ── A command this workspace already knows, offered while you type ────────
  //
  // The clean split between a learned command and a real AI: the AI path is
  // untouched (enter still sends), and this appears BESIDE the sentence before
  // it is sent, so taking the free one is a choice rather than something that
  // happened to you. It works whether or not AI is connected — a workspace with
  // a model still has no reason to spend a call on something it already knows.
  const [suggestion, setSuggestion] = useState<BasicCommandOffer | null>(null);
  /** The answer to what is being typed, when the workspace can answer it
   *  itself. A read is safe to just do, so this is the answer rather than an
   *  offer to go and get it. */
  const [peek, setPeek] = useState<{ answer: string; detail?: string; from: "page" | "workspace" | "guide" } | null>(null);
  // Whether this workspace has taught itself ANYTHING. Checked once, because a
  // workspace with no commands must not send a request per keystroke forever.
  const knowsCommands = useQuery({
    queryKey: ["commands-any", activeSlug],
    queryFn: () => api.listCommands(activeSlug),
    enabled: open && !!activeSlug,
    staleTime: 5 * 60_000,
  });
  const hasCommands = (knowsCommands.data?.items ?? []).some((c) => c.enabled);

  useEffect(() => {
    if (!hasCommands || !open) {
      setSuggestion(null);
      return;
    }
    const text = input.trim();
    // Short enough to be mid-word is too short to match anything meaningful,
    // and asking on every keystroke of a long message is a request per letter.
    if (text.length < 8) {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .matchCommand(activeSlug, text, getChatSelection()?.ids)
        .then((r) => {
          if (!cancelled) setSuggestion(r.command);
        })
        .catch(() => {
          if (!cancelled) setSuggestion(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [input, hasCommands, open, activeSlug]);

  // A question the workspace can answer itself, answered while it is typed.
  // Separate from the command lookup because it has nothing to do with what
  // this workspace has been taught: every workspace can count its own records.
  useEffect(() => {
    if (!open) {
      setPeek(null);
      return;
    }
    const text = input.trim();
    if (text.length < 8) {
      setPeek(null);
      return;
    }
    // The tab first. "What page am I on?" is a fact this browser is already
    // holding, so asking the server for it is one request more than the right
    // number, and asking a model is a great deal more than that.
    const local = localAnswerFor(text, getChatPageContext());
    if (local) {
      setPeek({ ...local, from: "page" });
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .peekAnswer(activeSlug, text, !aiOff)
        .then((r) => {
          if (!cancelled)
            setPeek(
              r.answer
                ? { answer: r.answer, ...(r.detail ? { detail: r.detail } : {}), from: r.from === "guide" ? "guide" : "workspace" }
                : null,
            );
        })
        .catch(() => {
          if (!cancelled) setPeek(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [input, open, activeSlug, aiOff]);

  /** Take the free path: run what the workspace already knows, and never ask a
   *  model. The sent message still appears in the conversation, because what
   *  you asked for is part of the history whoever ran it. */
  async function acceptSuggestion() {
    const s = suggestion;
    const text = input.trim();
    if (!s || !text || busy) return;
    setInput("");
    setSuggestion(null);
    setPeek(null);
    setHistory((h) => {
      const entries = remember(h.entries, text);
      saveHistory(activeSlug, entries);
      return { entries, index: null, draft: "" };
    });
    const next: Msg[] = [
      ...messages,
      { role: "user", content: text, ...(selection ? { sentWith: selection } : {}) },
    ];
    setMessages(next);
    setBusy(true);
    try {
      const out = await api.runCommand(activeSlug, s.id, text, getChatSelection()?.ids);
      if (out.ok) workspaceChanged();
      setMessages([
        ...next,
        {
          role: "assistant",
          content: (out.ok ? "✓ " : "✗ ") + out.message,
          // The free path writes to the workspace like any other path, so it
          // owes the same undo. Without this, the ONE way of changing things
          // that never involves a model was also the only one you could not
          // take back.
          ...(out.ledger_ids?.length
            ? { resolved: true, ledgerIds: out.ledger_ids, undoable: true }
            : {}),
        },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "That didn't work.";
      setMessages([...next, { role: "assistant", content: `✗ ${msg}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setHistory((h) => {
      const entries = remember(h.entries, text);
      saveHistory(activeSlug, entries);
      return { entries, index: null, draft: "" };
    });
    setSeedPlaceholder(null);
    setError(null);
    const next: Msg[] = [
      ...messages,
      { role: "user", content: text, ...(selection ? { sentWith: selection } : {}) },
    ];
    setMessages(next);

    // No AI provider → ask the server's basic-mode matcher (no model, no cost)
    // instead of hitting the AI chat only to render a failure. The endpoint
    // always returns a reply (its own graceful no-match nudge); the fallback
    // below only fires if the endpoint itself is unreachable.
    if (aiOff) {
      setBusy(true);
      try {
        // The prior turn, so control words can point at something: the last
        // untaken offer, the last command that ran, the last change's handles.
        const prior: import("../lib/api").BasicPrior = {};
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i]!;
          if (!prior.ran && m.ranCommand) prior.ran = m.ranCommand;
          if (!prior.offered && m.command && !m.resolved) {
            prior.offered = { id: m.command.id, message: m.command.message };
          }
          if (!prior.ledger_ids && !m.undone) {
            const handles = m.ledgerIds ?? (m.ledgerId ? [m.ledgerId] : []);
            if (handles.length) prior.ledger_ids = handles;
          }
        }
        const r = await api.answerBasic(activeSlug, text, Object.keys(prior).length ? prior : undefined);
        if (r.act) {
          const act = r.act;
          // Mark what the act consumed, so the next "yes" cannot take it twice.
          const consume = (pred: (m: Msg) => boolean, patch: Partial<Msg>) =>
            setMessages((prev) => {
              const copy = [...prev];
              for (let i = copy.length - 1; i >= 0; i--) {
                if (pred(copy[i]!)) { copy[i] = { ...copy[i]!, ...patch }; break; }
              }
              return copy;
            });
          setMessages([...next, { role: "assistant", content: r.reply }]);
          if (act.kind === "run-command") {
            const out = await api.runCommand(activeSlug, act.id, act.message, getChatSelection()?.ids).catch(
              (e: unknown) => ({ ok: false, message: e instanceof ApiError ? e.message : "That didn't work.", ledger_ids: [] as string[] }),
            );
            if (out.ok) workspaceChanged();
            consume((m) => !!m.command && !m.resolved, { resolved: true });
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: (out.ok ? "✓ " : "✗ ") + out.message,
              ...(out.ok ? { ranCommand: { id: act.id, message: act.message } } : {}),
              ...(out.ledger_ids?.length ? { resolved: true, ledgerIds: out.ledger_ids, undoable: true } : {}),
            }]);
          } else if (act.kind === "undo") {
            let ok = 0;
            for (const id of act.ledger_ids) {
              const u = await api.aiChatUndo(activeSlug, id).catch(() => ({ ok: false, message: "" }));
              if (u.ok) ok++;
            }
            if (ok) workspaceChanged();
            consume((m) => (m.ledgerIds ?? (m.ledgerId ? [m.ledgerId] : [])).length > 0 && !m.undone, { undone: true });
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: ok === act.ledger_ids.length ? "✓ Undone." : ok ? `✓ Undid ${ok} of ${act.ledger_ids.length}.` : "✗ I couldn't undo that.",
            }]);
          } else {
            consume((m) => !!m.command && !m.resolved, { resolved: true });
          }
          setBusy(false);
          return;
        }
        setMessages([
          ...next,
          {
            role: "assistant",
            content: r.reply,
            // A learned command is an OFFER. Basic mode answers a keystroke; it
            // must never write to the workspace on its own, however sure the
            // match is.
            ...(r.command ? { command: { ...r.command, message: text } } : {}),
          },
        ]);
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
        getChatSelection() ?? undefined,
      );
      // NOT cleared on send. A conversation stays about the thing it is about:
      // Cobb asks which shelves you mean, you answer, and an answer with no
      // context is how he ends up asking the same question twice. It goes when
      // you drop it, when you tick something else, or when the page it came
      // from does.
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
  /** What has happened so far, oldest first. A LIST, not one line.
   *
   *  The panel used to show a single replaced string, so a ninety-second turn
   *  read as the word "Thinking" for a minute and a half: every step scrolled
   *  past invisibly and the one thing left on screen was the least informative.
   *  Keeping them means the wait shows its work. */
  const [steps, setSteps] = useState<Array<{ text: string; state: "doing" | "done" | "failed" }>>([]);
  /** Ledgered writes a relayed assistant made during this turn, waiting for the
   *  answer they belong beside. Each one is an Undo the person can press. */
  const relayApplied = useRef<Msg[]>([]);
  const selection = useChatSelection();

  // A half-written question is work. Reloading the page (or being reloaded by a
  // deploy) threw it away, which is the kind of small loss that teaches people
  // not to type anything long in the box. Per workspace, on this device.
  const draftKey = `cobblr.chat.draft.${activeSlug}`;
  useEffect(() => {
    if (!activeSlug) return;
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) setInput((cur) => (cur ? cur : saved));
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug]);
  useEffect(() => {
    if (!activeSlug) return;
    try {
      if (input.trim()) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {
      /* private mode */
    }
  }, [input, activeSlug, draftKey]);
  // Only while the panel is open: watching every selection change in the app
  // otherwise is work nobody asked for.
  useSelectionCapture(open);
  /** The turn currently being followed — the id an "undo all" names. */
  const turnIdRef = useRef<string | null>(null);
  /** Which card is being put back, and how far along. */
  const [undoing, setUndoing] = useState<{ idx: number; done: number; total: number } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  /** The answer as it is being written. Rendered under the steps, so the words
   *  appear where the reply will end up rather than in a separate place that
   *  then vanishes. */
  const [streaming, setStreaming] = useState("");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  /** Fold one event into the step list. */
  function applyEvent(kind: string, data: Record<string, unknown>): void {
    setSteps((prev) => {
      switch (kind) {
        case "thinking":
          // Only the FIRST think is a step of its own; the later ones are the
          // gap between tools and would otherwise fill the list with the word.
          return (data.round as number) > 0 ? prev : [...prev, { text: "Thinking", state: "doing" as const }];
        case "tool": {
          const done = prev.map((x) => (x.state === "doing" ? { ...x, state: "done" as const } : x));
          return [...done, { text: describeTool(String(data.name ?? ""), (data.args as Record<string, unknown>) ?? {}), state: "doing" as const }];
        }
        case "tool-result": {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i]!.state === "doing") {
              copy[i] = { ...copy[i]!, state: data.ok ? "done" : "failed" };
              break;
            }
          }
          return copy;
        }
        case "applied": {
          // A step that carries a ledger id is a change the person can put
          // back. The in-app path builds those cards from the turn's result;
          // a relayed assistant's writes are applied one at a time, from the
          // far side of the model call, so THIS is where they arrive.
          // A relayed assistant's writes arrive HERE rather than in the turn's
          // result, so this is the only place that knows the workspace just
          // changed.
          workspaceChanged();
          const bulkIds = Array.isArray(data.ledger_ids)
            ? (data.ledger_ids as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
          if (bulkIds.length > 1) {
            const key = bulkIds.join(",");
            if (!relayApplied.current.some((m) => (m.ledgerIds ?? []).join(",") === key)) {
              relayApplied.current.push({
                role: "assistant",
                content: String(data.summary ?? `Made ${bulkIds.length} changes.`),
                resolved: true,
                ledgerIds: bulkIds,
                ...(turnIdRef.current ? { undoTurnId: turnIdRef.current } : {}),
                undoable: data.undoable === true,
              });
            }
          } else if (typeof data.ledger_id === "string") {
            // Held aside rather than pushed into the conversation now: the
            // turn's final render is built from the message list as it was
            // when the turn STARTED, so anything appended mid-turn is
            // discarded when the answer lands. These are handed to that
            // render instead, and arrive with the answer, exactly where the
            // in-app path puts them.
            // One ledger row is one card, however many times its event is
            // seen: a follower that reconnects replays, a second tab follows
            // the same turn, and React mounts an effect twice in development.
            // Undo is idempotent, but showing the same change twice tells the
            // person their shelf was created twice.
            const id = String(data.ledger_id);
            if (relayApplied.current.some((m) => m.ledgerId === id)) return prev;
            relayApplied.current.push({
              role: "assistant",
              content: String(data.summary ?? "Done."),
              resolved: true,
              ledgerId: id,
              undoable: data.undoable === true,
            });
          }
          // Resolve the step that was already saying what it was doing, rather
          // than adding a line. "Adding a location" followed by `Applied:
          // {"id":"8943a0b0-0ff9-41dd…","short_name":null,"depth":0}` tells a
          // person nothing they wanted and buries the steps that do.
          const name = typeof data.summary === "string" && data.summary.length <= 60 && !data.summary.startsWith("{")
            ? data.summary
            : null;
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const at = copy[i];
            if (at && at.state === "doing") {
              copy[i] = { ...at, state: "done" as const, ...(name ? { text: `${at.text}: ${name}` } : {}) };
              return copy;
            }
          }
          return [...copy, { text: name ? `Done: ${name}` : "Done", state: "done" as const }];
        }
        case "text-delta":
          // The answer has started arriving, so the step list has done its job.
          return prev.map((x) => (x.state === "doing" ? { ...x, state: "done" as const } : x));
        default:
          return prev;
      }
    });
  }

  async function followTurn(turnId: string, next: Msg[]) {
    turnIdRef.current = turnId;
    // One follower at a time; a newer turn supersedes an older subscription.
    followingRef.current?.abort();
    setBusy(true);
    setSteps([]);
    setStartedAt(Date.now());
    setElapsed(0);
    setStreaming("");

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
      if (ev.event === "text-delta") {
        const piece = String((data as { text?: string }).text ?? "");
        if (piece) setStreaming((prev) => prev + piece);
      }
      applyEvent(ev.event, data);
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
    setSteps([]);
    setStartedAt(null);
    setStreaming("");
    setBusy(false);
    // A relayed assistant's writes were applied one at a time from inside the
    // model call, so they are not in `r.applied` — they arrived as events. Put
    // their cards in front of the answer, where the in-app ones go.
    const relayCards = relayApplied.current;
    relayApplied.current = [];
    applyResponse(relayCards.length ? [...next, ...relayCards] : next, r);
  }
  function failFollow(msg: string) {
    rememberOpenTurn(null);
    relayApplied.current = [];
    setSteps([]);
    setStartedAt(null);
    setStreaming("");
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
        workspaceChanged();
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

  async function undoWrite(idx: number, force = false) {
    const m = messages[idx];
    const handles = m?.ledgerIds ?? (m?.ledgerId ? [m.ledgerId] : []);
    // `undone` marks a card whose undo has run. A FORCED press is the second
    // half of that same undo — the part the first press deliberately held back
    // and told the person about — so it is not blocked by it.
    if (!m || handles.length === 0 || (m.undone && !force) || busy) return;
    try {
      // One press, every row the instruction made. Reversed newest-first so a
      // later change never depends on an earlier one still being there, and
      // counted rather than narrated: sixty "↩ Deleted Shelf 3." lines is not
      // a report, it is the same wall of text the cards were meant to replace.
      // ONE instruction, one request. The server holds the changes that turn
      // made and puts them back newest-first; the client does not post sixty
      // ids and hope its list is the same list.
      if (m.undoTurnId && handles.length > 1) {
        setUndoing({ idx, done: 0, total: handles.length });
        const r = await api.aiChatUndoTurn(activeSlug, m.undoTurnId, force);
        setUndoing(null);
        setMessages((prev) => {
          const copy = [...prev];
          if (copy[idx]) copy[idx] = { ...copy[idx]!, undone: r.ok };
          return [
            ...copy,
            {
              role: "assistant",
              content: (r.ok ? "↩ " : "✗ ") + r.message,
              // The dead end becomes a choice: it names what it left and lets
              // the person say "those too". Nothing happens until they do.
              ...(r.can_force && !force
                ? { offerForceTurnId: m.undoTurnId, offerForceCount: (r.held ?? []).length }
                : {}),
            },
          ];
        });
        return;
      }
      const outcomes = [];
      const total = handles.length;
      for (const h of [...handles].reverse()) {
        // No turn to name (an older card, or a single change): press the
        // handles this card holds, counting out loud — a button that only
        // greys out for a minute is the same "is it stuck?" as before.
        if (total > 1) setUndoing({ idx, done: outcomes.length, total });
        outcomes.push(await undoMut.mutateAsync(h));
      }
      setUndoing(null);
      const ok = outcomes.filter((o) => o.ok).length;
      const message =
        outcomes.length === 1
          ? (outcomes[0]!.ok ? "↩ " : "✗ ") + outcomes[0]!.message
          : ok === outcomes.length
            ? `↩ Put back all ${ok}.`
            : `↩ Put back ${ok} of ${outcomes.length}. ${outcomes.find((o) => !o.ok)?.message ?? ""}`;
      setMessages((prev) => {
        const copy = [...prev];
        if (copy[idx]) copy[idx] = { ...copy[idx]!, undone: ok > 0 };
        return [...copy, { role: "assistant", content: message }];
      });
    } catch (e) {
      setUndoing(null);
      const msg = e instanceof ApiError ? e.message : "Couldn't undo that.";
      setMessages((prev) => [...prev, { role: "assistant", content: "✗ " + msg }]);
    }
  }

  if (!activeSlug) return null;

  return (
    <RailTabContent
      id="cobb"
      title={
        <>
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
        </>
      }
      actions={
        messages.length > 0 ? (
          <button
            type="button"
            onClick={clearChat}
            className="text-faint hover:text-content dark:hover:text-mortar-200 transition p-1"
            aria-label="Clear conversation"
            title="Clear this conversation"
          >
            <Trash2 size={15} />
          </button>
        ) : null
      }
    >

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
            {/* The big Cobb is the EMPTY panel — nothing said, nothing typed.
                He steps aside the moment there is something to show, so his
                first answer arrives exactly where every later one does: inline,
                on the left, at reply size. Otherwise the first reply appears
                UNDER a full-size Cobb, with a second small Cobb beside it, and
                the panel has two of him in it.

                Keyed off the composer having text rather than off the answer
                itself, so he leaves once, when you start typing, instead of
                flickering in and out as a half-typed sentence stops and starts
                matching. Clear the box and he comes back. */}
            {messages.length === 0 && !peek && !busy && !input.trim() && (
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
                <div key={i} className="flex items-start justify-end gap-1.5">
                  {/* What the message was sent WITH, to the LEFT of it: the
                      space beside a right-aligned bubble is already empty, and
                      a line above would cost height on every message that had
                      context. Scrolled back to weeks later, "tell me about
                      these" still says which two racks it meant. */}
                  {m.sentWith && (
                    <span
                      className="mt-1 shrink min-w-0 max-w-[45%] inline-flex items-center gap-1 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900 px-1.5 py-0.5 text-[10px] text-cobble-800 dark:text-cobble-100"
                      title={m.sentWith.text ?? m.sentWith.label}
                    >
                      <span className="truncate">{m.sentWith.label}</span>
                    </span>
                  )}
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
                  {/* A command this workspace taught itself. No AI was asked;
                      the sentence matched something it already knows how to do,
                      and it still waits to be told to go ahead. */}
                  {m.command && !m.resolved && (
                    <div className="mt-2">
                      <div className="text-[11px] text-muted dark:text-slate-400">
                        {m.command.summary} · learned from “{m.command.template}”
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void runCommand(i)}
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                        >
                          <Check size={13} /> Do it
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
                  {/* The offer. It appears only after an undo has already told
                      the person what it left and why, and it names the count so
                      the second press is a decision, not a repeat of the first. */}
                  {m.offerForceTurnId && !m.undone && (
                    <div className="mt-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          const at = messages.findIndex((x) => x.undoTurnId === m.offerForceTurnId);
                          if (at >= 0) void undoWrite(at, true);
                        }}
                        disabled={undoMut.isPending}
                        className="rounded-md border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-ember-500 hover:border-ember-400 text-[11px] font-medium px-2 py-0.5 transition disabled:opacity-50"
                      >
                        {m.offerForceCount === 1 ? "Take that one back too" : `Take those ${m.offerForceCount} back too`}
                      </button>
                    </div>
                  )}
                  {(m.ledgerId || (m.ledgerIds?.length ?? 0) > 0) && m.undoable && !m.undone && (
                    <div className="mt-1.5">
                      <button
                        type="button"
                        onClick={() => void undoWrite(i)}
                        disabled={undoMut.isPending}
                        className="rounded-md border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-ember-500 hover:border-ember-400 text-[11px] font-medium px-2 py-0.5 transition disabled:opacity-50"
                      >
                        {undoing?.idx === i
                          ? m.undoTurnId
                            ? `Putting back ${undoing.total}…`
                            : `Putting back ${undoing.done + 1} of ${undoing.total}…`
                          : (m.ledgerIds?.length ?? 0) > 1
                            ? `↩ Undo all ${m.ledgerIds!.length}`
                            : "↩ Undo"}
                      </button>
                    </div>
                  )}
                  {m.undone && <div className="mt-1 text-[11px] text-faint">↩ undone</div>}
                </div>
              );
              return el;
            })}
            {/* Waiting on a reply. Cobb's poses are STATES, not decoration, so
                the wait is where `working` belongs: he's at the bench while you
                wait, instead of a generic dot. Deliberately small and static —
                he shows up because something is happening, and leaves when it
                stops. */}
            {/* Cobb, answering before the question was even sent.
                It is HIM talking, in his own bubble, where his answers appear —
                not a widget bolted to the composer. Green because it has to be
                tellable apart from a real reply at a glance: this one came from
                the workspace itself, costs nothing, and is already true, so a
                reader should never have to wonder which kind of answer they are
                looking at. */}
            {peek && !busy && (
              <div className="flex items-end gap-3">
                <Cobb pose="idea" size={46} title="Cobb already knows" className="cobb-lift shrink-0" />
                <div className="cobb-bubble cobb-bubble-sm relative rounded-lg px-3 py-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900">
                  {/* The guide's answers are written as prose with bullets and
                      bold, the way his real replies are; the other two are one
                      short line, and marching them through a markdown renderer
                      would only cost them their crispness. */}
                  {peek.from === "guide" ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5 break-words text-emerald-800 dark:text-emerald-300 prose-strong:text-emerald-900 dark:prose-strong:text-emerald-200">
                      <ReactMarkdown>{peek.answer}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{peek.answer}</div>
                  )}
                  {peek.detail && (
                    <div className="text-[11px] text-emerald-700/80 dark:text-emerald-400/70">{peek.detail}</div>
                  )}
                  {/* Say which, honestly: the page's own state and a read of
                      your records are different claims, and one of them is not
                      about your data at all. */}
                  <div className="mt-0.5 text-[10px] text-emerald-700/60 dark:text-emerald-400/50">
                    {peek.from === "page"
                      ? "from the page you are on, no AI used"
                      : peek.from === "guide"
                        ? "from what Cobb already knows, no AI used"
                        : "straight from your workspace, no AI used"}
                  </div>
                </div>
              </div>
            )}
            {busy && (
              <div className="flex items-center gap-3">
                <Cobb pose="working" size={52} title="Cobb, at work" className="cobb-lift shrink-0" />
                {/* The "…" is HIS speech bubble (tail pointing back at him), not
                    a widget that happens to sit nearby — same device as the
                    Build greeting, in miniature. */}
                {/* Everything he has done, not just the latest word for it.
                    A single replaced line meant a 90-second turn showed
                    "Thinking" for a minute and a half while every step that
                    would have explained the wait scrolled past invisibly. The
                    list keeps them, the last one ticks along with the clock,
                    and the oldest fall off so it cannot grow past the panel. */}
                <div className="cobb-bubble cobb-bubble-sm relative rounded-lg px-3 py-2 bg-subtle dark:bg-slate-800 text-sm min-w-0" aria-live="polite">
                  {steps.length === 0 ? (
                    <span className="text-faint">…</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {steps.slice(-5).map((st, i, shown) => (
                        <li key={`${st.text}-${i}`} className="flex items-baseline gap-1.5 leading-snug">
                          <span
                            className={
                              st.state === "done"
                                ? "text-emerald-600 dark:text-emerald-400 shrink-0"
                                : st.state === "failed"
                                  ? "text-ember-500 shrink-0"
                                  : "text-faint shrink-0"
                            }
                          >
                            {st.state === "done" ? "✓" : st.state === "failed" ? "✗" : "›"}
                          </span>
                          <span className={st.state === "doing" ? "text-content dark:text-mortar-200" : "text-faint"}>
                            {st.text}
                            {/* The clock rides the CURRENT step only, and only
                                once a wait is long enough to wonder about. */}
                            {st.state === "doing" && i === shown.length - 1 && elapsed >= 3 && (
                              <span className="ml-1 text-[10px] font-mono text-faint">{elapsed}s</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* The answer, as it is written. Once words are arriving the
                      steps have said all they can, and this is the thing the
                      person was waiting for. */}
                  {streaming && (
                    <div className="mt-1.5 pt-1.5 border-t border-line/60 dark:border-slate-700/60 text-content dark:text-mortar-200 whitespace-pre-wrap">
                      {streaming}
                      <span className="inline-block w-1.5 h-3.5 ml-0.5 align-[-1px] bg-cobble-500 animate-pulse" />
                    </div>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div className="text-xs text-ember-500 bg-ember-50 dark:bg-ember-900/20 rounded px-3 py-2">{error}</div>
            )}
          </div>

          {/* Something this workspace already knows how to do fits what is
              being typed. Offered, not taken: enter still sends to the AI, and
              this is the cheaper door standing open beside it. */}
          {suggestion && !busy && (
            <div className="border-t border-line dark:border-slate-700 px-3 pt-2 shrink-0">
              <button
                type="button"
                onClick={() => void acceptSuggestion()}
                className="w-full text-left rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-2.5 py-1.5 hover:bg-cobble-100 dark:hover:bg-cobble-900/50 transition"
              >
                <span className="flex items-center gap-2">
                  <Wand2 size={13} className="text-accent shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs text-content dark:text-mortar-200 truncate">
                      {/* A computed command's summary is a sentence and ends
                          like one; a bound one is a fragment. Either way this
                          reads as one line, not "…of each., no AI needed". */}
                      {suggestion.summary.replace(/\.\s*$/, "")}, no AI needed
                    </span>
                    <span className="block text-[10px] font-mono text-faint dark:text-slate-500 truncate">
                      {suggestion.template}
                    </span>
                  </span>
                  <kbd className="shrink-0 text-[10px] font-mono text-faint dark:text-slate-500 border border-line dark:border-slate-600 rounded px-1">
                    tab
                  </kbd>
                </span>
              </button>
            </div>
          )}

          {/* What you are pointing at, held where you can see it — and drop it.
              A highlight is gone the moment the caret enters this box, so it is
              captured as a chip instead of being read back at send-time. */}
          <div className="border-t border-line dark:border-slate-700 p-3 flex flex-col gap-2 shrink-0">
            {selection && (
              // INSIDE the box, at its top. Three attempts got here:
              //   a row of its own above the composer — a second divider and a
              //     strip of chrome that read as a section;
              //   absolutely positioned over the composer's edge — no divider,
              //     but it covered the last line of the conversation and, being
              //     translucent, showed the words through itself.
              // Part of the input's own box is what "anchored to the top of the
              // text input" actually means: no divider between them, nothing
              // overlapping, opaque.
              <div className="flex">
                <div className="inline-flex items-center gap-1.5 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900 px-2 py-1 text-[11px] text-cobble-800 dark:text-cobble-100 max-w-full">
                  {/* Not "In context" — that is the vocabulary of the tool, not
                      of the person using it. What the chip means is "this is what
                      my next message is about". */}
                  <span className="shrink-0 opacity-70">About:</span>
                  <span className="truncate font-medium" title={selection.text ?? selection.label}>
                    {selection.label}
                    {/* The words, only when they add something. A highlight that
                        resolved to a record already reads as its name. */}
                    {selection.text && selection.text.trim() !== selection.label
                      ? ` — “${selection.text.slice(0, 60)}${selection.text.length > 60 ? "…" : ""}”`
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearChatSelection()}
                    className="shrink-0 opacity-60 hover:opacity-100"
                    title="Don't include this"
                    aria-label="Remove from context"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-end gap-2">
            <textarea
              ref={setTa}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Typing ends the walk through history: what is in the box is
                // yours again, and Down should not drag an old draft back over it.
                setHistory(stopBrowsing);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                  return;
                }
                // Tab takes the free path when one is on offer. Only then: tab
                // is how you leave a text box, and stealing it when there is
                // nothing to accept would trap the keyboard.
                if (e.key === "Tab" && suggestion && !e.shiftKey) {
                  e.preventDefault();
                  void acceptSuggestion();
                  return;
                }
                // Up/Down recall the messages you sent. Only with a plain,
                // collapsed caret: Shift+Up is a selection, Alt/Meta+Up is the
                // platform's own word/document jump, and a caret mid-message
                // must still move a line at a time.
                const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
                const el = e.currentTarget;
                const collapsed = el.selectionStart === el.selectionEnd;
                if (!plain || !collapsed) return;
                if (e.key === "ArrowUp" && caretOnFirstLine(input, el.selectionStart)) {
                  const back = recallOlder(history, input);
                  if (!back) return; // nothing older — leave the key alone
                  e.preventDefault();
                  setHistory(back.state);
                  showRecalled(back.value);
                } else if (e.key === "ArrowDown" && caretOnLastLine(input, el.selectionStart)) {
                  const forward = recallNewer(history);
                  if (!forward) return;
                  e.preventDefault();
                  setHistory(forward.state);
                  showRecalled(forward.value);
                }
              }}
              rows={1}
              placeholder={seedPlaceholder ?? "Ask or tell me to do something… (Shift+Enter for a new line)"}
              title="Enter sends, Shift+Enter starts a new line, ↑ and ↓ bring back what you sent before"
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
          </div>
    </RailTabContent>
  );
}
