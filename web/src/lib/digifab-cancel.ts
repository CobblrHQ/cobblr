// What pressing Cancel on a print did, in one sentence, the same wherever the
// button is. A cancel counts only when the printer confirms it: a job used to
// read "Cancelled" while its printer kept printing (#4031), so the words must
// say which of the three things happened.
export interface CancelResult {
  status: string;
  remote_cancelled: boolean;
  /** The printer was told and has not stopped yet; Cobblr finishes the cancel when it does. */
  cancelling?: boolean;
  message?: string;
}

export function cancelOutcome(r: CancelResult): { tone: "success" | "info"; text: string } {
  if (r.cancelling) return { tone: "info", text: r.message ?? "Cancel sent; waiting for the printer to stop." };
  if (r.remote_cancelled) return { tone: "success", text: "Cancelled. The printer stopped." };
  return { tone: "success", text: "Cancelled. It hadn't reached a printer yet." };
}

export function canCancelJob(job: { status: string; external?: boolean; target_device: string | null; remote_job_id: string | null }): boolean {
  return !["completed", "failed", "cancelled"].includes(job.status) && !job.external && !(job.target_device === "lightburn" && !!job.remote_job_id);
}
