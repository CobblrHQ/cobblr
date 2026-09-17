// The requests waiting on this workspace's owners and admins, on the page
// where they manage what people may do. The bell and the Discord DM carry the
// same card with the same two buttons; this is the one that does not scroll
// away, for an approver who missed both. Deciding here runs the same
// function the press does (approval-requests.ts → approvals.ts).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ApprovalRequestView } from "../lib/api";

const PRIMARY = "inline-flex items-center gap-1 rounded border border-cobble-500 bg-cobble-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cobble-700 disabled:opacity-50";
const SECONDARY = "inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 px-2.5 py-1 text-[11px] font-medium text-muted hover:text-content disabled:opacity-50";

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function ApprovalRequestsCard({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: ["approval-requests", slug, "open"],
    queryFn: () => api.listApprovalRequests(slug, "open"),
    enabled: !!slug,
  });
  const decide = useMutation({
    mutationFn: (args: { id: string; decision: "approve" | "deny" }) =>
      api.decideApprovalRequest(slug, args.id, args.decision, notes[args.id]?.trim() || null),
    onSuccess: (r) => {
      toast.success(r.request.status === "approved" ? "Approved. They have been told." : "Declined. They have been told.");
      void qc.invalidateQueries({ queryKey: ["approval-requests", slug] });
      void qc.invalidateQueries({ queryKey: ["permissions-matrix", slug] });
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : String(e));
      void qc.invalidateQueries({ queryKey: ["approval-requests", slug] });
    },
  });

  if (!list.data?.can_decide) return null;
  const pending = list.data.items.filter((r) => r.status === "pending");
  const answered = list.data.items.filter((r) => r.status !== "pending");

  return (
    <section
      id="requests"
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-accent">// requests</span>
        <span className="text-xs text-muted dark:text-slate-400">
          {pending.length === 0 ? "Nothing waiting on you." : `${pending.length} waiting on you.`} A yes gives exactly what was asked, to that person.
        </span>
      </div>
      {pending.length > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-800">
          {pending.map((r) => (
            <RequestRow key={r.id} r={r} note={notes[r.id] ?? ""} onNote={(v) => setNotes((n) => ({ ...n, [r.id]: v }))} busy={decide.isPending} onDecide={(d) => decide.mutate({ id: r.id, decision: d })} />
          ))}
        </ul>
      )}
      {answered.length > 0 && (
        <details className="text-xs text-muted dark:text-slate-400">
          <summary className="cursor-pointer">{answered.length} approved, waiting for them to finish</summary>
          <ul className="mt-1 space-y-1">
            {answered.map((r) => (
              <li key={r.id} id={`request-${r.id}`}>
                {r.requester.name}: {r.subject} ({r.remedies.map((x) => x.label).join(", ")}), approved by {r.decided_by?.name ?? "an admin"}.
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function RequestRow({
  r,
  note,
  onNote,
  busy,
  onDecide,
}: {
  r: ApprovalRequestView;
  note: string;
  onNote: (v: string) => void;
  busy: boolean;
  onDecide: (d: "approve" | "deny") => void;
}) {
  return (
    <li id={`request-${r.id}`} className="py-2 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-sm text-content dark:text-mortar-100">{r.requester.name}</span>
        <span className="text-sm text-content dark:text-mortar-100">asks for {r.remedies.map((x) => x.label).join(" and ")}</span>
        <span className="text-xs text-muted dark:text-slate-400">to {r.subject.charAt(0).toLowerCase() + r.subject.slice(1)}</span>
        <span className="text-[11px] text-faint dark:text-slate-500">{ago(r.created_at)}</span>
      </div>
      {r.note && <blockquote className="text-xs text-muted dark:text-slate-400 border-l-2 border-line dark:border-slate-700 pl-2">{r.note}</blockquote>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          maxLength={500}
          placeholder="A word for them (optional)"
          className="flex-1 min-w-[10rem] rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs"
        />
        <button type="button" disabled={busy} onClick={() => onDecide("approve")} className={PRIMARY}>
          <Check size={12} /> Approve
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide("deny")} className={SECONDARY}>
          <X size={12} /> Deny
        </button>
      </div>
    </li>
  );
}
