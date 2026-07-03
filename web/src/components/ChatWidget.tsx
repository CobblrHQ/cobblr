// Floating AI chat — bottom-right launcher → RIGHT SIDEBAR. Agentic: the
// assistant chats AND can DO things — it proposes a create/action the user
// CONFIRMS before it runs (core-ai /chat → proposal → /chat/execute). Assistant
// messages render markdown; the input auto-grows. Portals to <body> so the
// header's backdrop-blur can't trap its position:fixed (CLAUDE.md modal note).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Sparkles, X, Send, Check } from "lucide-react";
import { api, ApiError, type AiChatProposal, type BundleValidationPreview } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface Msg {
  role: "user" | "assistant";
  content: string;
  proposal?: AiChatProposal; // assistant proposed a write — needs confirm
  buildPreview?: BundleValidationPreview; // build-proposal: what applying enables/adds
  buildSeedCount?: number; // build-proposal: starter records apply will create
  building?: boolean; // a whole-workspace build is running in the background (poll)
  buildDraftId?: string; // matches the polled draft (stable across new messages)
  resolved?: boolean; // proposal confirmed or cancelled
}

const kindLabel = (id: string) => id.split(":")[1] ?? id;

/** `open`/`setOpen` are lifted to AppLayout so the main content can shift left
 *  when the panel opens (the two breakpoint-gated instances share one state). */
export function ChatWidget({ open, setOpen, asRow = false }: { open: boolean; setOpen: (v: boolean) => void; asRow?: boolean }) {
  const { activeSlug } = useActiveOrg();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  // Auto-grow the input with its content (up to a cap), then shrink back.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const r = await api.aiChat(
        activeSlug,
        next.map((m) => ({ role: m.role, content: m.content })),
      );
      if (r.type === "build-proposal" && r.building && r.draft_id) {
        // The build runs async (~150s). Show a "designing…" message and poll
        // the draft until it's ready, then swap in the preview + confirm.
        const draftId = r.draft_id;
        setMessages([
          ...next,
          { role: "assistant", content: r.summary ?? "Designing your workspace…", building: true, buildDraftId: draftId },
        ]);
        void pollBuild(draftId);
      } else if (r.type === "proposal" && r.proposal) {
        setMessages([...next, { role: "assistant", content: r.summary ?? "I can do that — confirm?", proposal: r.proposal }]);
      } else {
        setMessages([...next, { role: "assistant", content: r.text ?? "(no response)" }]);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Something went wrong.";
      setError(/no provider|not entitled|not available|no_ai/i.test(msg) ? "AI isn't enabled for this workspace yet." : msg);
    } finally {
      setBusy(false);
    }
  }

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
    patch({ building: false, content: "That took longer than expected — try again in a moment." });
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
      setMessages((prev) => [...prev, { role: "assistant", content: (r.ok ? "✓ " : "✗ ") + r.message }]);
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
    setMessages((prev) => [...prev, { role: "assistant", content: "Okay — left it alone." }]);
  }

  if (!activeSlug) return null;

  return (
    <>
      {/* Header trigger — an icon button in the navbar's right cluster (was a
          floating bottom-right FAB that overlapped modals/cards). The panel
          still portals to <body> so the header's backdrop-blur can't trap it. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={asRow ? "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition" : "transition p-1.5 text-faint dark:text-slate-500 hover:text-accent"}
        title="Ask Cobblr"
        aria-label="Ask Cobblr"
      >
        <Sparkles size={16} className="shrink-0" />
        {asRow && <span>Ask Cobblr</span>}
      </button>

      {open &&
        createPortal(
        <div className="fixed top-0 right-0 z-[60] h-screen w-[min(100vw,440px)] border-l border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl flex flex-col">
          <header className="flex items-center justify-between px-4 py-3 border-b border-line dark:border-slate-700 shrink-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-content dark:text-mortar-100">
              <Sparkles size={16} className="text-accent" /> Ask Cobblr
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-faint hover:text-content dark:hover:text-mortar-200 transition" aria-label="Close">
              <X size={18} />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && (
              <p className="text-xs text-faint dark:text-slate-500 text-center mt-8 px-4 leading-relaxed">
                Ask about your workspace, or tell me to do something — "add a part called Widget", "what's low on stock?".
                I'll always check with you before changing anything.
              </p>
            )}
            {messages.map((m, i) =>
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
                  {m.building && (
                    <div className="mt-1 flex items-center gap-2 text-xs text-faint dark:text-slate-500">
                      <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
                      Turning on modules and building your fields — this takes a minute or two…
                    </div>
                  )}
                  {m.buildPreview && !m.resolved && (
                    <div className="mt-2 rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/60 px-3 py-2 text-xs space-y-1.5">
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
                  )}
                  {m.proposal && !m.resolved && (
                    <div className="mt-2 flex gap-2">
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
                </div>
              ),
            )}
            {busy && (
              <div className="text-left">
                <div className="inline-block rounded-lg px-3 py-2 bg-subtle dark:bg-slate-800 text-faint text-sm">…</div>
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
              placeholder="Ask or tell me to do something… (Shift+Enter for a new line)"
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
        </div>,
          document.body,
        )}
    </>
  );
}
