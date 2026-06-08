// Always-on feedback button. Any signed-in user can report a bug, flag something
// confusing, or suggest an idea from anywhere in the app. Auto-attaches the page
// + browser so triage (super-admin → Feedback) has context. POSTs to /feedback.

import { useState } from "react";
import { Modal, useToast } from "@cobblr/platform-web";
import { MessageSquare } from "lucide-react";
import { api } from "../lib/api";

const TYPES = [
  { id: "bug", label: "🐛 Bug" },
  { id: "confusing", label: "😕 Confusing" },
  { id: "idea", label: "💡 Idea" },
] as const;

type FType = (typeof TYPES)[number]["id"];

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FType>("bug");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function submit() {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const slug = window.location.pathname.match(/^\/w\/([^/]+)/)?.[1];
      await api.submitFeedback({
        type,
        message: text,
        workspace_slug: slug,
        context: {
          url: window.location.href,
          route: window.location.pathname,
          userAgent: navigator.userAgent,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        },
      });
      toast.info("Thanks — your feedback was sent.");
      setMessage("");
      setType("bug");
      setOpen(false);
    } catch {
      setError("Couldn't send that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Send feedback"
        aria-label="Send feedback"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full bg-cobble-600 hover:bg-cobble-700 text-white shadow-lg px-3 py-2.5 text-xs font-medium transition"
      >
        <MessageSquare size={15} />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Send feedback" size="md">
        <div className="space-y-3">
          <div className="flex gap-2">
            {TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setType(t.id)}
                className={
                  "px-2.5 py-1 text-xs rounded-md border transition " +
                  (type === t.id
                    ? "bg-cobble-100 dark:bg-cobble-900/30 border-cobble-400 text-accent"
                    : "border-line dark:border-slate-700 text-muted hover:border-cobble-300")
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            autoFocus
            placeholder="What happened, what's confusing, or what you'd love to see…"
            className="w-full rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-sm text-content dark:text-mortar-100"
          />
          <div className="text-[10px] text-faint dark:text-slate-500">
            We attach the page you're on + your browser so we can track it down.
          </div>
          {error && <div className="text-xs text-ember-500">{error}</div>}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !message.trim()}
            className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send feedback"}
          </button>
        </div>
      </Modal>
    </>
  );
}
