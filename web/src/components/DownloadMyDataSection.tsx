// "Download my data" (#4185): a person's own copy of what Cobblr holds about
// them, whatever their role anywhere. Beside Delete account, on purpose:
// before you delete, take your data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { downloadBlob, useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";

export function DownloadMyDataSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["my-data-exports"],
    queryFn: () => api.myDataExports(),
    // While one builds, look again every few seconds; otherwise leave it.
    refetchInterval: (q) => (q.state.data?.items.some((e) => e.status === "building") ? 3000 : false),
  });
  const ask = useMutation({
    mutationFn: () => api.requestMyData(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-data-exports"] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "We could not start that. Try again."),
  });
  const latest = list.data?.items[0];
  const days = list.data?.days ?? 7;
  // One a day: offer another only when the server would make it.
  const canAsk = !latest || latest.status === "failed" || Date.now() - Date.parse(latest.created_at) > 24 * 3_600_000;
  const save = async (id: string) => {
    try {
      downloadBlob(await api.downloadMyData(id), `my-cobblr-data.zip`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That copy is not here.");
    }
  };
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2" data-testid="download-my-data">
      <div className="text-sm font-medium text-content dark:text-mortar-100">Download my data</div>
      <div className="text-xs text-muted">
        A copy of what Cobblr holds about you: your profile, the workspaces you belong to, your tokens and connections (never
        their secrets), your notification settings, what you did and what you sent us. The records in a workspace stay with
        that workspace's backup. One copy a day, kept for {days} days.
      </div>
      {latest?.status === "building" && <p className="text-xs text-muted" data-testid="my-data-building">Putting it together…</p>}
      {latest?.status === "ready" && (
        <button
          type="button"
          onClick={() => void save(latest.id)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 text-sm font-medium hover:bg-subtle dark:hover:bg-slate-800"
          data-testid="my-data-download"
        >
          <Download size={14} /> Download (ready {new Date(latest.ready_at ?? latest.created_at).toLocaleDateString()})
        </button>
      )}
      {latest?.status === "failed" && <p className="text-xs text-ember-600 dark:text-ember-400">The last copy could not be made. Ask again.</p>}
      {canAsk && (
        <button
          type="button"
          disabled={ask.isPending}
          onClick={() => ask.mutate()}
          className="ml-2 inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-accent hover:underline disabled:opacity-50"
          data-testid="my-data-ask"
        >
          {ask.isPending ? "Asking…" : latest?.status === "ready" ? "Make a new copy" : "Make a copy"}
        </button>
      )}
    </section>
  );
}
