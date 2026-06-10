// Always-on feedback button. Any signed-in user can report a bug, flag something
// confusing, or suggest an idea from anywhere in the app. Auto-attaches the page
// + browser, and lets them attach screenshot(s) of the issue, so triage
// (super-admin → Feedback) has context. POSTs to /feedback.

import { useState, useRef, useEffect } from "react";
import { Modal, useToast } from "@cobblr/platform-web";
import { MessageSquare, ImagePlus, X } from "lucide-react";
import { api } from "../lib/api";

const TYPES = [
  { id: "bug", label: "🐛 Bug" },
  { id: "confusing", label: "😕 Confusing" },
  { id: "idea", label: "💡 Idea" },
] as const;

type FType = (typeof TYPES)[number]["id"];

const MAX_SHOTS = 5;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB / image

interface Pick {
  file: File;
  url: string; // object URL for the preview (revoked on remove/close)
}

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FType>("bug");
  const [message, setMessage] = useState("");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Screenshots upload to the workspace's core-files, so they need a workspace.
  const slug = window.location.pathname.match(/^\/w\/([^/]+)/)?.[1];

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next: Pick[] = [];
    for (const file of Array.from(list)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_BYTES) {
        setError(`"${file.name}" is over 10 MB — skipped.`);
        continue;
      }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setPicks((cur) => {
      const merged = [...cur, ...next];
      if (merged.length > MAX_SHOTS) {
        // Say so — silently dropping is exactly the "did my paste work?"
        // confusion this widget is supposed to prevent.
        merged.slice(MAX_SHOTS).forEach((p) => URL.revokeObjectURL(p.url));
        setError(`Up to ${MAX_SHOTS} screenshots — extra ${merged.length - MAX_SHOTS === 1 ? "one was" : "ones were"} skipped.`);
      }
      return merged.slice(0, MAX_SHOTS);
    });
  }

  // Cmd/Ctrl+V while the modal is open attaches a copied screenshot — the most
  // natural way to drop one in. Window-level (capture) because the focused
  // element is usually the textarea; image items attach, plain text still
  // pastes into the textarea untouched. Thumbnails in the preview strip are
  // the confirmation that the paste landed (feedback 7298ad1c).
  useEffect(() => {
    if (!open || !slug) return;
    function onPaste(e: ClipboardEvent) {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (!files.length) return;
      e.preventDefault(); // image paste is ours; text paste falls through
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      addFiles(dt.files);
    }
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug]);

  function removePick(i: number) {
    setPicks((cur) => {
      const p = cur[i];
      if (p) URL.revokeObjectURL(p.url);
      return cur.filter((_, idx) => idx !== i);
    });
  }

  function reset() {
    picks.forEach((p) => URL.revokeObjectURL(p.url));
    setPicks([]);
    setMessage("");
    setType("bug");
    setStage(null);
    setError(null);
  }

  function close() {
    reset();
    setOpen(false);
  }

  async function submit() {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      let attachments: Array<{ file_id: string; name?: string; content_type?: string }> = [];
      if (slug && picks.length) {
        setStage(`Uploading ${picks.length} screenshot${picks.length === 1 ? "" : "s"}…`);
        attachments = [];
        for (const p of picks) {
          const rec = await api.uploadFile(slug, p.file);
          attachments.push({ file_id: rec.id, name: p.file.name, content_type: p.file.type });
        }
      }
      setStage("Sending…");
      await api.submitFeedback({
        type,
        message: text,
        workspace_slug: slug,
        attachments,
        context: {
          url: window.location.href,
          route: window.location.pathname,
          userAgent: navigator.userAgent,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        },
      });
      toast.info("Thanks — your feedback was sent.");
      close();
    } catch {
      setError("Couldn't send that. Please try again.");
    } finally {
      setBusy(false);
      setStage(null);
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

      <Modal open={open} onClose={close} title="Send feedback" size="md">
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
            className="w-full rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-base sm:text-sm text-content dark:text-mortar-100"
          />

          {/* Screenshots */}
          {slug ? (
            <div className="space-y-2">
              {picks.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {picks.map((p, i) => (
                    <div
                      key={i}
                      className="relative w-16 h-16 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800"
                    >
                      <img src={p.url} alt={p.file.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removePick(i)}
                        className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/50 text-white hover:bg-ember-600 transition"
                        title="Remove"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {picks.length < MAX_SHOTS && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-accent border border-dashed border-line dark:border-slate-700 hover:border-cobble-400 rounded-md px-2.5 py-1.5 transition"
                >
                  <ImagePlus size={14} />
                  Attach screenshot{picks.length ? "s" : ""}{" "}
                  <span className="text-faint">— or paste one (up to {MAX_SHOTS})</span>
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = ""; // allow re-picking the same file
                }}
              />
            </div>
          ) : null}

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
            {busy ? (stage ?? "Sending…") : "Send feedback"}
          </button>
        </div>
      </Modal>
    </>
  );
}
