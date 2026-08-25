// Always-on feedback button. Any signed-in user can report a bug, flag something
// confusing, or suggest an idea from anywhere in the app. Auto-attaches the page
// + browser, and lets them attach screenshot(s) of the issue, so triage
// (super-admin → Feedback) has context. POSTs to /feedback.
//
// SELF-HOSTED: that row never leaves the operator's own box, so the widget also
// offers a copy-paste report for the public issue tracker — the only route by
// which a Cobblr bug found on a self-hosted instance reaches the project.

import { useState, useRef, useEffect } from "react";
import { HIDE_WHEN_OVERLAY_OPEN } from "@cobblr/platform-web";
import { createPortal } from "react-dom";
import { Modal, useToast } from "@cobblr/platform-web";
import { BookOpen, Copy, ExternalLink, Github, ImagePlus, MessageCircle, MessageSquare, Users, X } from "lucide-react";
import { api, type CommunityLink } from "../lib/api";
import { newIssueUrl, reportBody, type ReportInput, type ServerDiagnostics } from "../lib/bug-report";
import { useAuth } from "../auth/AuthContext";
import { resolveHandle } from "../auth/ActiveOrgContext";

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

// Default: a floating bottom-right pill (top-bar mode). `asRow`: a sidebar-foot
// row (full-sidebar mode), matching NotificationsBell/ChatWidget — the pill has
// no home there and everything else already lives in the foot.
export function FeedbackWidget({ asRow = false }: { asRow?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FType>("bug");
  const [message, setMessage] = useState("");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Self-hosted feedback never leaves the box: the row lands in this operator's
  // own cobblr_meta and only their own super-admin reads it. So on self-hosted
  // the widget ALSO produces a report for the public tracker, which is the only
  // way a Cobblr bug found here can reach the Cobblr project.
  const [hosted, setHosted] = useState<boolean | null>(null);
  const [diag, setDiag] = useState<ServerDiagnostics | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { orgs, user } = useAuth();

  // The floating pill owns the bottom-right corner. Reserve room above it so
  // toasts (same corner, higher z) stack ABOVE the pill instead of overlapping
  // it — the pill is a persistent CTA and shouldn't flicker away for a transient
  // toast. Cleared on unmount so surfaces without the pill get the default. The
  // sidebar-row variant isn't in that corner, so it reserves nothing.
  useEffect(() => {
    if (asRow) return;
    const el = document.documentElement;
    el.style.setProperty("--toast-safe-bottom", "4.75rem");
    return () => {
      el.style.removeProperty("--toast-safe-bottom");
    };
  }, [asRow]);

  // Screenshots upload to a workspace's core-files + the feedback row stores
  // that same workspace_slug (the super-admin viewer reads the bytes under it),
  // so an effective slug is required to attach. Derive it from the URL —
  // matching BOTH the admin shell (/w/:slug) and the member portal
  // (/portal/:slug) — then fall back to the user's first workspace. Without
  // this, every slug-less page (portal, /admin, login landing, public
  // surfaces) hid the attach UI entirely: a user literally "stuck on
  // uploading a screenshot" (feedback ee0f8b06).
  // Map the URL handle to a CURRENT workspace. A tab left open across a
  // workspace rename has a STALE handle that resolves to nothing — uploading the
  // screenshot to that dead slug 404s and lost the whole report. So resolve the
  // handle against the user's live orgs; fall back to their first workspace.
  // Never rely on the raw URL slug being valid.
  const urlHandle = window.location.pathname.match(/^\/(?:w|portal)\/([^/]+)/)?.[1];
  const activeOrg = (urlHandle ? resolveHandle(urlHandle, orgs) : null) ?? orgs[0] ?? null;
  const slug = activeOrg?.slug;
  // Best-effort breadcrumb: the slug the URL claimed, when it no longer matches
  // a live workspace (so the report still records where the user thought it was).
  const attemptedSlug = urlHandle && !resolveHandle(urlHandle, orgs) ? urlHandle : undefined;

  // Fetch the deployment flag + environment once the modal is opened, not on
  // mount: every signed-in page renders this widget, and a closed widget has no
  // reason to cost two requests.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      // Resolve the deployment flag once…
      let h = hosted;
      if (h === null) {
        try {
          const cfg = await api.authConfig();
          h = cfg.hosted === true;
        } catch {
          // Unknown deployment: fall back to the hosted behaviour, which
          // always works (the row is stored either way).
          h = true;
        }
        if (!live) return;
        setHosted(h);
      }
      // …and fetch diagnostics SEPARATELY, so a slug that arrives after the
      // flag resolves (orgs load async) still gets its environment block. The
      // old single-shot guard latched on `hosted !== null` and could never
      // recover: open the widget early and every report said "unknown".
      if (h === false && slug && !diag) {
        try {
          const d = await api.diagnostics(slug);
          if (live) setDiag(d);
        } catch {
          // A report without the environment block still beats no report.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [open, hosted, slug, diag]);

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
    setCopied(false);
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

  function currentReport(): ReportInput {
    return {
      type,
      message,
      route: window.location.pathname,
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screenshots: picks.length,
      server: diag,
    };
  }

  /** A fork's operator points "Open an issue" at their own tracker via
   *  COBBLR_ISSUES_URL (the "issues" community link); stock self-hosts fall
   *  back to the public upstream repo inside newIssueUrl. */
  const issuesBase = user?.community_links?.find((l) => l.id === "issues")?.url;

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(reportBody(currentReport()));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Couldn't reach the clipboard. Select the text below and copy it.");
    }
  }

  async function submit() {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const attachments: Array<{ file_id: string; name?: string; content_type?: string }> = [];
      let droppedShots = 0;
      if (slug && picks.length) {
        setStage(`Uploading ${picks.length} screenshot${picks.length === 1 ? "" : "s"}…`);
        for (const p of picks) {
          // A failed screenshot upload must NOT lose the whole report — submit
          // the text regardless. (Also covers a stale workspace slug in a tab
          // that was open across a workspace rename: the upload 404s, the
          // feedback still goes through.)
          try {
            const rec = await api.uploadFile(slug, p.file);
            attachments.push({ file_id: rec.id, name: p.file.name, content_type: p.file.type });
          } catch {
            droppedShots += 1;
          }
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
          ...(attemptedSlug ? { attempted_slug: attemptedSlug } : {}),
        },
      });
      // On self-hosted, "sent" would be a lie: the row never leaves this box.
      const sent = hosted === false ? "saved to this instance" : "sent";
      toast.info(
        droppedShots
          ? `Thanks — your feedback was ${sent} (couldn't attach ${droppedShots} screenshot${droppedShots === 1 ? "" : "s"}).`
          : `Thanks — your feedback was ${sent}.`,
      );
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
      {asRow ? (
        // Sidebar-foot row (full-sidebar mode) — same shape as the
        // Notifications / Ask Cobb rows it sits beside.
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Send feedback"
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
        >
          <MessageSquare size={16} className="shrink-0" />
          Feedback
        </button>
      ) : (
        /* Portaled to <body> so an ancestor's backdrop-blur / transform can't trap
           or blur this fixed button (the navbar uses backdrop-blur). z above the
           modal backdrop (z-50) so feedback stays reachable while a form is open —
           exactly what the user asked for. */
        createPortal(
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Send feedback"
            aria-label="Send feedback"
            className={"fixed bottom-4 right-4 z-[55] " + HIDE_WHEN_OVERLAY_OPEN + " flex items-center gap-1.5 rounded-full bg-cobble-600 hover:bg-cobble-700 text-white shadow-lg px-3 py-2.5 text-xs font-medium transition"}
          >
            <MessageSquare size={15} />
            <span className="hidden sm:inline">Feedback</span>
          </button>,
          document.body,
        )
      )}

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
                  <span className="text-faint"> - or paste one (up to {MAX_SHOTS})</span>
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
          ) : (
            // No workspace at all (e.g. a platform admin with zero workspaces):
            // there's nowhere to store a screenshot. Say so instead of hiding
            // the affordance and leaving the reporter guessing.
            <div className="text-[10px] text-faint dark:text-slate-500">
              Screenshots attach once you're in a workspace - text feedback works fine from here.
            </div>
          )}

          <div className="text-[10px] text-faint dark:text-slate-500">
            {hosted === false
              ? diag
                ? "This stays on your own instance. To report it to the Cobblr project, copy the report below - it includes your version, browser and enabled modules."
                : "This stays on your own instance. To report it to the Cobblr project, copy the report below - it carries your browser and page, but no server details until you're in a workspace."
              : "We attach the page you're on + your browser so we can track it down."}
          </div>
          {error && <div className="text-xs text-ember-500">{error}</div>}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !message.trim()}
            className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition disabled:opacity-50"
          >
            {busy ? (stage ?? "Sending…") : hosted === false ? "Save to this instance" : "Send feedback"}
          </button>
          {hosted === false && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copyReport()}
                disabled={!message.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-line dark:border-slate-600 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 px-3 py-2 transition disabled:opacity-50"
              >
                <Copy size={14} /> {copied ? "Copied" : "Copy report"}
              </button>
              <a
                href={message.trim() ? newIssueUrl(currentReport(), issuesBase) : undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!message.trim()}
                className={
                  "flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-line dark:border-slate-600 text-sm px-3 py-2 transition " +
                  (message.trim()
                    ? "text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800"
                    : "opacity-50 pointer-events-none text-faint")
                }
              >
                <ExternalLink size={14} /> Open an issue
              </a>
            </div>
          )}
          {/* Places to take a question that isn't a tracked report. A LIST,
              because there are three of them now and there was room for one.
              The server decides which exist and in what order (see
              api/src/platform/community.ts); this only draws them. */}
          <CommunityLinks user={user} />
        </div>
      </Modal>
    </>
  );
}

/** Somewhere to go, as opposed to something to send.
 *
 *  Distinct from "Open an issue" above it on purpose: that button carries the
 *  report you just typed, so it SUBMITS this. These are places you go with a
 *  question, and they take nothing with them. */
function CommunityLinks({ user }: { user?: { community_links?: CommunityLink[]; discord_invite_url?: string | null } | null }) {
  // An older server sends only discord_invite_url. Synthesising the chat entry
  // from it keeps a mid-upgrade deployment from losing the link it had.
  const links: CommunityLink[] =
    user?.community_links?.length
      ? user.community_links
      : user?.discord_invite_url
        ? [{ id: "chat", label: "Discord", url: user.discord_invite_url, blurb: "Ask a question and get an answer the same day." }]
        : [];
  if (links.length === 0) return null;

  const icon: Record<CommunityLink["id"], typeof MessageCircle> = {
    chat: MessageCircle,
    forum: Users,
    issues: Github,
    docs: BookOpen,
  };

  return (
    <div className="border-t border-line dark:border-slate-700 pt-3 space-y-1.5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        Or ask somewhere
      </div>
      {links.map((l) => {
        const Icon = icon[l.id] ?? MessageCircle;
        return (
          <a
            key={l.id}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2.5 rounded-md px-2 py-1.5 -mx-2 hover:bg-subtle dark:hover:bg-slate-800/60 transition"
          >
            <Icon size={15} className="text-accent mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm text-content dark:text-mortar-100">{l.label}</span>
              <span className="block text-xs text-muted dark:text-slate-400">{l.blurb}</span>
            </span>
            <ExternalLink size={12} className="ml-auto mt-1 shrink-0 text-faint" />
          </a>
        );
      })}
    </div>
  );
}
