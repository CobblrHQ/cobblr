// A record someone else deleted while it was open (#4115).
//
// The page keeps what it showed, and what the person was typing, and says
// above it who deleted the record and when. Someone allowed to restore gets
// the way back on the spot; anyone else is told whom to ask. A record read
// by a link after it was deleted gets the same sentence instead of a raw
// "not found".

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workspaceFetch } from "./acting-role";
import { useCan } from "./can";

type GetToken = () => string | null;

/** Did this read fail because the record is no longer there? */
export function isRecordGone(err: unknown): boolean {
  // 404-is: a-state: the record was there when the page opened and someone deleted it since.
  return (err as { status?: unknown } | null | undefined)?.status === 404;
}

interface DeletedEntry { id: string; entity_id: string; name: string; deleted_by: string | null; deleted_at: string }

async function call<T>(slug: string, getToken: GetToken, method: "GET" | "POST", path: string): Promise<T> {
  const token = getToken();
  const res = await workspaceFetch(`/api/v1/orgs/${slug}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new Error((parsed as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`);
  return parsed as T;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ` on ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

/** What to say when a record is gone: who deleted it, when, and the way back. */
export function RecordGone({ slug, getToken, kind, id, noun, kept = true }: {
  slug: string;
  getToken: GetToken;
  /** The record's kind, as Recently deleted files it ("inventory:part"). */
  kind: string;
  id: string;
  /** What the person calls it ("part", "task"). */
  noun: string;
  /** False when the page has nothing of the record left to show. */
  kept?: boolean;
}) {
  const qc = useQueryClient();
  const mayRestore = useCan("platform:restore-deleted-record") === true;
  const entry = useQuery({
    queryKey: ["record-gone", slug, kind, id],
    queryFn: async () => (await call<{ items: DeletedEntry[] }>(slug, getToken, "GET", `/deleted-records?kind=${encodeURIComponent(kind)}`)).items.find((e) => e.entity_id === id) ?? null,
    // The deletion is filed a moment after the record goes; ask again until it is.
    refetchInterval: (q) => (q.state.data ? false : 3000),
    retry: false,
  });
  const restore = useMutation({
    mutationFn: (entryId: string) => call(slug, getToken, "POST", `/deleted-records/${entryId}/restore`),
    onSuccess: () => qc.invalidateQueries(),
  });
  const found = entry.data ?? null;
  const who = found?.deleted_by ?? null;
  const keptLine = kept ? " What you typed is still on this page." : "";
  return (
    <div role="alert" data-testid="record-gone" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-content dark:text-mortar-100 space-y-2">
      <p>
        {found
          ? `This ${noun} was deleted by ${who ?? "an automated action"}${when(found.deleted_at)}.${keptLine}`
          : `This ${noun} was deleted, or moved somewhere you cannot open.${keptLine}`}
      </p>
      {found && mayRestore && (
        <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(found.id)} className="rounded-md border border-line px-3 py-2 font-medium">
          {restore.isPending ? "Restoring…" : `Restore this ${noun}`}
        </button>
      )}
      {found && !mayRestore && <p>{who ? `Ask ${who} to restore it from Recently deleted.` : "Ask a workspace admin to restore it from Recently deleted."}</p>}
      {restore.error && <p>{(restore.error as Error).message}</p>}
    </div>
  );
}
