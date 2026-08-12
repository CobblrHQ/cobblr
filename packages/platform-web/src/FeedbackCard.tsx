// One feedback report, rendered the same way wherever it came from.
//
// Moved out of web/src/pages/AdminConsole.tsx so the ops hub can render the SAME
// component against its cross-instance mirror instead of growing another copy — it grew
// two already, and the second one was visibly worse than this. See feedback-source.ts
// for the seam and docs/design-decisions/operator-console-split.md for why the hub does
// not simply proxy through an instance.
//
// The only behavioural change from the original: where it called
// `api.feedbackAttachmentRawUrl` directly it now asks the source, and a source that
// cannot serve tenant files (the hub) returns null, so the card says where the
// screenshots are instead of rendering a broken image.

import { useState } from "react";
import { Modal } from "./Modal";
import { useImageSrc } from "./useImageSrc";
import { isForeign, type FeedbackSource, type FeedbackSourceItem, type FeedbackUpdate } from "./feedback-source";

export const FEEDBACK_STATUSES = [
  "new",
  "triaged",
  "in_progress",
  "awaiting_decision",
  "backlog",
  "resolved",
  "wontfix",
] as const;

// `awaiting_decision` = the autopilot posted a spec/question card; OPEN and in the
// working queue (not hidden in backlog) until the author picks Build/Pursue/Pass/Backlog.
const FEEDBACK_STATUS_LABEL: Record<string, string> = { awaiting_decision: "awaiting you" };
export const fbStatusLabel = (s: string) => FEEDBACK_STATUS_LABEL[s] ?? s.replace(/_/g, " ");

const PRIORITY_CHIP: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

export function PriorityChip({ priority }: { priority: "urgent" | "high" | "medium" | "low" }) {
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded font-mono uppercase text-[10px] font-semibold " +
        (PRIORITY_CHIP[priority] ?? PRIORITY_CHIP.low)
      }
    >
      {priority}
    </span>
  );
}

function ValidViableChip({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return null;
  return (
    <span className={ok ? "text-moss-600 dark:text-moss-400" : "text-red-500 dark:text-red-400"}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

// A reporter-attached screenshot: thumbnail in the card, click to enlarge. The image
// routes through useImageSrc (Bearer → blob) since the raw endpoint is auth-gated; one
// `medium` fetch serves both the thumb and the lightbox.
function FeedbackShot({ url, name }: { url: string | null; name?: string }) {
  const [zoom, setZoom] = useState(false);
  const src = useImageSrc(url);
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        title={name || "screenshot"}
        className="w-16 h-16 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800"
      >
        {src ? (
          <img src={src} alt={name || "screenshot"} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-faint">…</div>
        )}
      </button>
      <Modal open={zoom} onClose={() => setZoom(false)} title={name || "Screenshot"} size="lg">
        {src ? (
          <img src={src} alt={name || "screenshot"} className="max-h-[70vh] w-auto mx-auto rounded" />
        ) : (
          <div className="text-xs text-faint p-8 text-center">loading…</div>
        )}
      </Modal>
    </>
  );
}

export function FeedbackCard({
  f,
  source,
  onUpdate,
}: {
  f: FeedbackSourceItem;
  source: Pick<FeedbackSource, "imageUrl" | "update">;
  onUpdate: (body: FeedbackUpdate) => void;
}) {
  const [notes, setNotes] = useState(f.admin_notes ?? "");
  const [reply, setReply] = useState("");
  // Third-person "what we fixed" note for the Discord feedback-resolved post.
  const [publicSummary, setPublicSummary] = useState("");
  const ctx = (f.context ?? {}) as { url?: string; route?: string };
  const emoji = f.type === "bug" ? "🐛" : f.type === "confusing" ? "😕" : f.type === "idea" ? "💡" : "•";
  // Acting means PATCHing the deployment that OWNS the item, so the question is whether
  // the SOURCE can do that — not whether the item is local. A hub source forwards to the
  // owning instance, so a foreign item is actionable there; an instance source only ever
  // returns its own rows. A source with no `update` at all is read-only and the controls
  // are hidden rather than offered and failing.
  const canAct = !!source.update;
  return (
    <li className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {f.instance_label && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cobble-100 text-accent dark:bg-cobble-700 dark:text-mortar-100">
            {f.instance_label}
          </span>
        )}
        <span>
          {emoji} <span className="font-mono uppercase text-accent">{f.type}</span>
        </span>
        {f.triage_priority && <PriorityChip priority={f.triage_priority} />}
        {f.origin === "discord" && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
            discord
          </span>
        )}
        <span className="text-faint dark:text-slate-500">
          {f.user_name || f.user_email || f.origin_ref?.username || "?"}
        </span>
        {f.workspace_slug && (
          <span className="text-faint dark:text-slate-500">· {f.workspace_name || f.workspace_slug}</span>
        )}
        <span className="text-faint dark:text-slate-500">· {new Date(f.created_at).toLocaleString()}</span>
        <div className="flex-1" />
        {canAct ? (
          <select
            value={f.status}
            onChange={(e) =>
              onUpdate({
                status: e.target.value,
                // On resolve, carry the "what we fixed" note into the Discord post.
                ...(e.target.value === "resolved" && publicSummary.trim()
                  ? { public_summary: publicSummary.trim() }
                  : {}),
              })
            }
            className="text-xs rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-1 py-0.5"
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {fbStatusLabel(s)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-faint dark:text-slate-500 font-mono">{fbStatusLabel(f.status)}</span>
        )}
        {/* Kept even when the item IS actionable from here: the screenshots and the full
            history live on the owning instance, and this is the way to them. */}
        {isForeign(f) && f.instance_base && (
          <a
            className="text-accent hover:underline"
            href={`${f.instance_base}/admin/feedback`}
            target="_blank"
            rel="noreferrer"
          >
            open on {f.instance_label} ↗
          </a>
        )}
      </div>
      <div className="text-content dark:text-mortar-100 whitespace-pre-wrap">{f.message}</div>
      {ctx.route && (
        <div className="text-[10px] font-mono text-faint dark:text-slate-500 break-all">@ {ctx.route}</div>
      )}
      {f.attachments?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {f.attachments.map((a) =>
            source.imageUrl(f, a.file_id, "medium") ? (
              <FeedbackShot key={a.file_id} url={source.imageUrl(f, a.file_id, "medium")} name={a.name} />
            ) : (
              <span key={a.file_id} className="text-[10px] text-faint dark:text-slate-500">
                🖼 {a.name || "screenshot"} (on {f.instance_label ?? "the instance"})
              </span>
            ),
          )}
        </div>
      )}
      {f.followups?.length > 0 && (
        <div className="border-l-2 border-indigo-300 dark:border-indigo-700 pl-2.5 space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-wide text-faint dark:text-slate-500">
            💬 {f.followups.length} follow-up{f.followups.length === 1 ? "" : "s"}
          </div>
          {f.followups.map((fu, i) => (
            <div key={i} className="text-xs">
              <span className="text-faint dark:text-slate-500">{fu.from}: </span>
              <span className="text-content dark:text-mortar-200 whitespace-pre-wrap">{fu.text}</span>
            </div>
          ))}
        </div>
      )}
      {f.triaged_at && (
        <div className="rounded-lg border border-line/70 dark:border-slate-800 bg-subtle/60 dark:bg-slate-800/40 p-2.5 space-y-1.5">
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wide text-faint dark:text-slate-500">
            <span>🤖 AI triage</span>
            <ValidViableChip ok={(f as { triage_valid?: boolean | null }).triage_valid ?? null} label="valid" />
            <ValidViableChip ok={(f as { triage_viable?: boolean | null }).triage_viable ?? null} label="viable" />
          </div>
          {f.triage_summary && (
            <div className="text-xs text-content dark:text-mortar-200">{f.triage_summary}</div>
          )}
          {f.triage_action && (
            <div className="text-xs text-faint dark:text-slate-400">
              <span className="font-medium text-accent">→ </span>
              {f.triage_action}
            </div>
          )}
        </div>
      )}
      {canAct && (
        <>
          <div className="flex items-end gap-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={1}
              placeholder="triage notes…"
              className="flex-1 text-xs rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
            />
            <button
              type="button"
              onClick={() => onUpdate({ admin_notes: notes })}
              className="text-xs px-2 py-1 rounded bg-cobble-600 hover:bg-cobble-700 text-white"
            >
              save note
            </button>
          </div>
          {/* Close the loop with the reporter — sends them an in-app notification
              ("we fixed it" / "we're looking into it"). Empty reply = a default
              keyed off the current status. */}
          <div className="flex items-end gap-2 border-t border-line/60 dark:border-slate-800 pt-2">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={`reply to ${f.user_name || f.user_email || f.origin_ref?.username || "the reporter"} ${f.origin === "discord" ? "(in Discord thread)" : "(in-app)"}…`}
              className="flex-1 text-xs rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
            />
            <button
              type="button"
              onClick={() => {
                onUpdate({ notify_reporter: true, reply_message: reply.trim() || undefined, status: f.status });
                setReply("");
              }}
              className="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white whitespace-nowrap"
              title="Send the reporter an in-app notification. Uses your reply, or a default based on the current status."
            >
              notify reporter
            </button>
          </div>
          {/* Public "what we fixed" note — third-person; posted to the Discord feedback
              channel when you set status → resolved. Not sent to the reporter. */}
          <input
            value={publicSummary}
            onChange={(e) => setPublicSummary(e.target.value)}
            placeholder="what we fixed (third-person - posts to Discord on resolve)…"
            className="w-full text-xs rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
          />
        </>
      )}
    </li>
  );
}
