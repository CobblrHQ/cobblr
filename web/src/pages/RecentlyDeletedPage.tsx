import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";

type Deleted = { id: string; kind: string; entity_id: string; name: string; source: string; deleted_by: string | null; deleted_at: string; purge_after: string; can_delete_forever: boolean };
type Page = { items: Deleted[]; hasMore: boolean };

export function RecentlyDeletedPage() {
  usePageTitle("Recently deleted");
  const { activeSlug } = useActiveOrg();
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["recently-deleted", activeSlug, kind], initialPageParam: 0,
    queryFn: ({ pageParam }) => api.request<Page>("GET", `/orgs/${activeSlug}/deleted-records?offset=${pageParam}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`),
    getNextPageParam: (last, pages) => last.hasMore ? pages.length * 100 : undefined, enabled: !!activeSlug,
  });
  const change = async (row: Deleted, forever: boolean) => {
    if (forever && !await confirm({ title: "Delete this record forever?", message: `${row.name} will be removed from Recently deleted. It cannot be restored after this.`, confirmLabel: "Delete forever", destructive: true })) return;
    setBusy(row.id);
    try {
      await api.request(forever ? "DELETE" : "POST", `/orgs/${activeSlug}/deleted-records/${row.id}${forever ? "" : "/restore"}`);
      await qc.invalidateQueries();
      toast.success(forever ? "Deleted forever." : `${row.name} restored.`);
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(null); }
  };
  const rows = (query.data?.pages.flatMap((p) => p.items) ?? []);
  return <div className="space-y-4">
    <p className="text-sm text-muted">Deleted records stay here for 30 days. Restore brings them back with their original details and contents.</p>
    {kind && <button type="button" className="text-sm underline" onClick={() => setParams({})}>Show all deleted records</button>}
    {query.isPending ? <p role="status">Loading deleted records…</p> : query.isError ? <p role="alert">{query.error.message}</p> : rows.length === 0 ? <p>No recently deleted records.</p> : <ul className="space-y-3">
      {rows.map((row) => {
        const days = Math.max(0, Math.ceil((Date.parse(row.purge_after) - Date.now()) / 86_400_000));
        return <li key={row.id} className="rounded-xl border border-line bg-surface p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold break-words">{row.name}</h2>
            <p className="text-sm text-muted break-words">From {row.source} · Deleted by {row.deleted_by ?? "an automated action"}</p>
            <p className="text-sm text-muted">{days === 1 ? "1 day left" : `${days} days left`} · Deleted {new Date(row.deleted_at).toLocaleDateString()}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void change(row, false)} className="rounded-md border border-line px-3 py-2 text-sm">{busy === row.id ? "Working…" : "Restore from Recently deleted"}</button>
            {row.can_delete_forever && <button type="button" disabled={busy !== null} onClick={() => void change(row, true)} className="rounded-md border border-line px-3 py-2 text-sm text-red-600 dark:text-red-400">Delete forever</button>}
          </div>
        </li>;
      })}
    </ul>}
    {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="rounded-md border border-line px-3 py-2 text-sm">Load more</button>}
  </div>;
}
