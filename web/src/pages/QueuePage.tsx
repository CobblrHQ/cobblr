// /configuration/queue — background-jobs admin. Lists every queue
// job for the active workspace (queued / running / done / failed)
// so admins can see what the core-queue worker is doing.
//
// Read-only for v0.1. A future v0.2 could add manual-retry buttons
// for failed jobs and a "cancel" for queued ones.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListTodo } from "lucide-react";
import { api, type QueueJob } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";

const STATUSES = ["queued", "running", "done", "failed"] as const;
type Status = (typeof STATUSES)[number];

export function QueuePage() {
  usePageTitle("Background queue");
  const { activeSlug } = useActiveOrg();
  const [statusFilter, setStatusFilter] = useState<"" | Status>("");

  const jobs = useQuery({
    queryKey: ["queue-jobs", activeSlug, statusFilter],
    queryFn: () =>
      api.listQueueJobs(activeSlug, {
        limit: 200,
        status: statusFilter || undefined,
      }),
    enabled: !!activeSlug,
    // Tight refresh so the page feels alive as jobs flow through.
    refetchInterval: 5_000,
  });

  const items = jobs.data?.items ?? [];

  const counts = items.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3 flex-wrap">
        <ListTodo size={20} className="text-cobble-600" />
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Background queue
        </h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {items.length} jobs
        </span>
        <div className="flex-1" />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | Status)}
          className="px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        >
          <option value="">all statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s} ({counts[s] ?? 0})
            </option>
          ))}
        </select>
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Background jobs for this workspace. The worker process polls
        every 5 seconds and reclaims stale locks after 15 minutes.
        Failed jobs retry with exponential backoff up to{" "}
        <code className="font-mono text-xs">max_attempts</code>; after
        that they sit as <code className="font-mono text-xs">failed</code>{" "}
        for inspection.
      </p>

      {jobs.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {!jobs.isLoading && items.length === 0 && (
        <div className="text-sm text-slate-500 italic">
          No jobs {statusFilter ? `with status "${statusFilter}"` : "yet"}.
        </div>
      )}

      {items.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-mortar-50/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Queue</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Attempts</th>
                <th className="text-left px-3 py-2">Run at</th>
                <th className="text-left px-3 py-2">Created</th>
                <th className="text-left px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {items.map((j) => (
                <Row key={j.id} job={j} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ job }: { job: QueueJob }) {
  return (
    <tr className="text-xs">
      <td className="px-3 py-2 font-mono text-slate-600 dark:text-mortar-200">
        {job.queue}
      </td>
      <td className="px-3 py-2">
        <StatusChip status={job.status} />
      </td>
      <td className="px-3 py-2 text-right font-mono text-slate-500">
        {job.attempts}/{job.max_attempts}
      </td>
      <td className="px-3 py-2 font-mono text-slate-500 dark:text-slate-400">
        {new Date(job.run_at).toLocaleString()}
      </td>
      <td className="px-3 py-2 font-mono text-slate-500 dark:text-slate-400">
        {new Date(job.created_at).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 truncate max-w-[300px]" title={job.error ?? ""}>
        {job.error ?? ""}
      </td>
    </tr>
  );
}

function StatusChip({ status }: { status: QueueJob["status"] }) {
  const palette: Record<QueueJob["status"], string> = {
    queued: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    running: "bg-cobble-100 text-cobble-700 dark:bg-cobble-900/40 dark:text-cobble-200",
    done: "bg-moss-100 text-moss-700 dark:bg-moss-900/40 dark:text-moss-200",
    failed: "bg-ember-100 text-ember-700 dark:bg-ember-900/30 dark:text-ember-200",
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${palette[status]}`}
    >
      {status}
    </span>
  );
}
