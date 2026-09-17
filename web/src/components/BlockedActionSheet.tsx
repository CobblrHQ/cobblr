// The one sheet a refusal opens, and the one that finishes an approved ask.
//
// Mounted once in the workspace shell. It reads the blocked-action store
// (lib/blocked-action.ts), which the api client raises on any 403 that
// carries an explanation, so every surface in the product gets this without
// knowing it exists: the prerequisite in words, who decides, an Ask button
// when asking is the remedy and an honest sentence when it is not, and the
// request already waiting if there is one.
//
// It also owns the way back. An approval reaches the person as a notification
// whose link reopens the page they were on with `?resume=<id>`; this sheet
// sees the param, shows what will be done, and on their press hands the draft
// out once (the server's compare-and-set) and replays the refused request
// under their own session. A yes that no longer holds is said, not replayed.

import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";
import { api, ApiError, type ApprovalRequestView } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { clearBlockedAction, subscribeBlockedAction, type RaisedBlock } from "../lib/blocked-action";

const PRIMARY = "inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium";
const SECONDARY = "rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm";

/** Names, as a person would list them: "Ada" / "Ada and Sam" / "Ada, Sam and 2 more". */
function listNames(names: string[], count: number): string {
  const shown = names.slice(0, 2);
  const rest = count - shown.length;
  if (shown.length === 0) return count === 1 ? "a workspace admin" : "the workspace admins";
  const base = shown.length === 1 ? shown[0]! : `${shown[0]} and ${shown[1]}`;
  return rest > 0 ? `${base} and ${rest} more` : base;
}

/** Words for the request card when the surface gave none: what the refused
 *  request was trying to save, if it named it. */
function subjectFor(raised: RaisedBlock): string {
  if (raised.subject) return raised.subject;
  const body = raised.refused?.body as { name?: unknown; title?: unknown } | null | undefined;
  const named = typeof body?.name === "string" ? body.name : typeof body?.title === "string" ? body.title : null;
  if (named) return `Save "${named.slice(0, 80)}"`;
  return "Finish what I was doing";
}

export function BlockedActionSheet() {
  const [raised, setRaised] = useState<RaisedBlock | null>(null);
  useEffect(() => subscribeBlockedAction(setRaised), []);
  const location = useLocation();
  const resumeId = useMemo(() => new URLSearchParams(location.search).get("resume"), [location.search]);

  return (
    <>
      {raised && <AskSheet raised={raised} onClose={clearBlockedAction} />}
      {resumeId && !raised && <ResumeSheet requestId={resumeId} />}
    </>
  );
}

// ── Asking ───────────────────────────────────────────────────────────────

function AskSheet({ raised, onClose }: { raised: RaisedBlock; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const location = useLocation();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [asked, setAsked] = useState<ApprovalRequestView | null>(null);
  const blocked: BlockedAction = raised.blocked;
  const who = listNames(blocked.approvers.names, blocked.approvers.count);

  const ask = useMutation({
    mutationFn: () =>
      api.createApprovalRequest(activeSlug, {
        remedies: blocked.remedies.map((r) => ({ kind: r.kind, key: r.key })),
        subject: subjectFor(raised),
        note: note.trim() || null,
        resume: raised.refused ? { method: raised.refused.method, path: raised.refused.path, body: raised.refused.body } : null,
        route: location.pathname,
      }),
    onSuccess: (r) => setAsked(r.request),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api.withdrawApprovalRequest(activeSlug, id),
    onSuccess: () => {
      toast.info("Request withdrawn.");
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Already waiting on the same thing: say so, offer to take it back.
  const pending = asked ?? null;
  const pendingId = pending?.id ?? blocked.pending?.id ?? null;
  const pendingSince = pending?.created_at ?? blocked.pending?.created_at ?? null;

  if (!blocked.requestable) {
    return (
      <Modal open onClose={onClose} size="sm" title="Not something you can do here" footer={<div className="flex justify-end"><button type="button" onClick={onClose} className={PRIMARY}>OK</button></div>}>
        <div className="flex gap-3">
          <ShieldOff size={20} className="shrink-0 text-muted dark:text-slate-400" aria-hidden />
          <div className="space-y-2 text-sm text-content dark:text-mortar-100">
            <p>{blocked.sentence}</p>
            {blocked.reason && <p className="text-muted dark:text-slate-400">{blocked.reason}</p>}
          </div>
        </div>
      </Modal>
    );
  }

  if (pendingId) {
    return (
      <Modal
        open
        onClose={onClose}
        size="sm"
        title={asked ? "Asked" : "Already asked"}
        footer={
          <div className="flex items-center justify-between gap-2">
            <button type="button" disabled={withdraw.isPending} onClick={() => withdraw.mutate(pendingId)} className={SECONDARY}>
              Withdraw
            </button>
            <button type="button" onClick={onClose} className={PRIMARY}>
              OK
            </button>
          </div>
        }
      >
        <div className="flex gap-3">
          <ShieldCheck size={20} className="shrink-0 text-accent" aria-hidden />
          <div className="space-y-2 text-sm text-content dark:text-mortar-100">
            <p>
              {asked ? `Asked ${who}.` : `You asked ${who}${pendingSince ? ` on ${new Date(pendingSince).toLocaleDateString()}` : ""}.`} You will get a
              notification when they answer, and the answer opens what you were doing so you can finish it. Nothing is lost in the meantime.
            </p>
            <p className="text-muted dark:text-slate-400">{blocked.sentence}</p>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Ask for it?"
      footer={
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onClose} className={SECONDARY}>
            Not now
          </button>
          <button type="button" disabled={ask.isPending} onClick={() => ask.mutate()} className={PRIMARY}>
            {ask.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Asking…
              </>
            ) : (
              `Ask ${who}`
            )}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-content dark:text-mortar-100">
        <p>{blocked.sentence}</p>
        <p className="text-muted dark:text-slate-400">
          {who} can give you exactly this, and nothing else. They get a card with Approve and Deny; you get told either way, and a yes reopens what you were
          doing.
        </p>
        <label className="block">
          <span className="text-xs text-muted dark:text-slate-400">A word for them (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1 w-full rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
            placeholder="Why, if it helps"
          />
        </label>
      </div>
    </Modal>
  );
}

// ── Finishing ────────────────────────────────────────────────────────────

function ResumeSheet({ requestId }: { requestId: string }) {
  const { activeSlug } = useActiveOrg();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [stale, setStale] = useState<string | null>(null);

  const view = useQuery({
    queryKey: ["approval-request", activeSlug, requestId],
    queryFn: () => api.getApprovalRequest(activeSlug, requestId),
    enabled: !!activeSlug && !dismissed,
  });

  const leave = () => {
    setDismissed(true);
    const params = new URLSearchParams(location.search);
    params.delete("resume");
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : "" }, { replace: true });
  };

  const finish = useMutation({
    mutationFn: async () => {
      // Handed out once; the server re-checks that the yes still holds
      // before it gives the draft back.
      const r = await api.resumeApprovalRequest(activeSlug, requestId);
      let outcome: { ok: boolean; status?: number; message?: string | null };
      try {
        await api.request(r.resume.method, r.resume.path, r.resume.body ?? undefined);
        outcome = { ok: true };
      } catch (e) {
        outcome = { ok: false, status: e instanceof ApiError ? e.status : undefined, message: e instanceof Error ? e.message : String(e) };
      }
      await api.completeApprovalRequest(activeSlug, requestId, outcome).catch(() => undefined);
      return outcome;
    },
    onSuccess: (outcome) => {
      if (outcome.ok) {
        toast.success("Done.");
        void qc.invalidateQueries();
        leave();
      } else {
        // The permission is in place; the draft itself was refused for its
        // own reason (a table renamed, a record gone). Said plainly, and the
        // person does it by hand from here.
        toast.error(outcome.message ?? "That did not go through. The permission is in place; do it again by hand.");
        leave();
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === "stale" || e.code === "not_approved" || e.code === "no_resume")) setStale(e.message);
      else toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });

  if (dismissed) return null;
  const req = view.data?.request;
  if (view.isLoading) return null;
  if (!req) {
    return (
      <Modal open onClose={leave} size="sm" title="Request not found" footer={<div className="flex justify-end"><button type="button" onClick={leave} className={PRIMARY}>OK</button></div>}>
        <p className="text-sm text-muted dark:text-slate-400">This request is not yours, or it no longer exists.</p>
      </Modal>
    );
  }
  const asks = req.remedies.map((r) => r.label).join(" and ");

  // A yes with nothing to finish is recorded completed at once; it still
  // reads as the yes it was.
  const granted = req.status === "approved" || (req.status === "completed" && !req.has_resume);
  if (stale || !granted) {
    const words =
      stale ??
      (req.status === "completed"
        ? "This was already finished."
        : req.status === "resuming"
          ? "You already started finishing this. If it did not go through, do it again by hand; the permission stays."
          : req.status === "denied"
            ? `${req.decided_by?.name ?? "An admin"} declined this.${req.decision_note ? ` "${req.decision_note}"` : ""}`
            : req.status === "pending"
              ? "This has not been answered yet."
              : "This request is no longer open.");
    return (
      <Modal open onClose={leave} size="sm" title={req.subject} footer={<div className="flex justify-end"><button type="button" onClick={leave} className={PRIMARY}>OK</button></div>}>
        <p className="text-sm text-content dark:text-mortar-100">{words}</p>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={leave}
      size="sm"
      title="Approved"
      subtitle={`${req.decided_by?.name ?? "An admin"} gave you ${asks}`}
      footer={
        req.has_resume ? (
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={leave} className={SECONDARY}>
              Not now
            </button>
            <button type="button" disabled={finish.isPending} onClick={() => finish.mutate()} className={PRIMARY}>
              {finish.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Finishing…
                </>
              ) : (
                `Finish: ${req.subject}`
              )}
            </button>
          </div>
        ) : (
          <div className="flex justify-end">
            <button type="button" onClick={leave} className={PRIMARY}>
              OK
            </button>
          </div>
        )
      }
    >
      <div className="space-y-2 text-sm text-content dark:text-mortar-100">
        <p>
          {req.has_resume
            ? "Pressing Finish does exactly what you were doing when you were refused, as you, once. Nothing has been done for you yet."
            : "The permission is in place. Nothing has been done for you: what you were doing is on this page, so do it again from here."}
        </p>
        {req.decision_note && <p className="text-muted dark:text-slate-400">"{req.decision_note}"</p>}
      </div>
    </Modal>
  );
}
