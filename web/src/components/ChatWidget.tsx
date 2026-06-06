// Floating AI chat — bottom-right launcher → popover. Plain conversation
// against the workspace's AI (capability "chat"): the auto-on managed provider
// powers it on the hosted cloud; a BYO key on self-host. No backend of its own —
// it calls the existing core-ai /invoke. Portals to <body> so the header's
// backdrop-blur can't trap its position:fixed (see CLAUDE.md modal-portal note).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, X, Send } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function ChatWidget() {
  const { activeSlug } = useActiveOrg();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Light workspace context so the assistant knows what the user tracks.
  const kindsQ = useQuery({
    queryKey: ["chat-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: open && !!activeSlug,
    staleTime: 60_000,
  });

  function systemPrompt(): string {
    const kinds = (kindsQ.data?.items ?? []).map((k) => k.display_name).join(", ");
    return (
      `You are the assistant inside Cobblr, a no-code platform where people enable modules to build their own app. ` +
      `The user is in their workspace "${activeSlug}".` +
      (kinds ? ` They currently track: ${kinds}.` : "") +
      ` Be concise and friendly. Help them understand and use their workspace. ` +
      `You can't take actions yet (that's coming) — if they ask you to change something, explain how they'd do it.`
    );
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const r = await api.invokeAi(activeSlug, {
        capability: "chat",
        input: { messages: [{ role: "system", content: systemPrompt() }, ...next] },
      });
      const result = r.result as { content?: string } | string;
      const reply = typeof result === "string" ? result : result?.content ?? "";
      setMessages([...next, { role: "assistant", content: reply || "(no response)" }]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Something went wrong.";
      setError(
        /no provider|not entitled|not available|ai_failed|disabled/i.test(msg)
          ? "AI isn't enabled for this workspace yet."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!activeSlug) return null;

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-[60] h-12 w-12 rounded-full bg-cobble-600 hover:bg-cobble-700 text-white shadow-lg flex items-center justify-center transition"
          title="Ask Cobblr"
          aria-label="Ask Cobblr"
        >
          <Sparkles size={20} />
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-[60] w-[min(92vw,380px)] h-[min(80vh,560px)] rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl flex flex-col overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 border-b border-line dark:border-slate-700 shrink-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-content dark:text-mortar-100">
              <Sparkles size={16} className="text-accent" /> Ask Cobblr
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-faint hover:text-content dark:hover:text-mortar-200 transition" aria-label="Close">
              <X size={16} />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-xs text-faint dark:text-slate-500 text-center mt-8 px-4">
                Ask me anything about your workspace — what you're tracking, how to set something up, or what Cobblr can do.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                <div
                  className={
                    "inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words " +
                    (m.role === "user"
                      ? "bg-cobble-600 text-white"
                      : "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-200")
                  }
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy && (
              <div className="text-left">
                <div className="inline-block rounded-lg px-3 py-2 bg-subtle dark:bg-slate-800 text-faint text-sm">…</div>
              </div>
            )}
            {error && (
              <div className="text-xs text-ember-500 bg-ember-50 dark:bg-ember-900/20 rounded px-3 py-2">{error}</div>
            )}
          </div>

          <div className="border-t border-line dark:border-slate-700 p-2 flex items-end gap-2 shrink-0">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Ask…"
              className="flex-1 resize-none px-3 py-2 text-sm rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-200 max-h-28"
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
      )}
    </>,
    document.body,
  );
}
