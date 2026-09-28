// Under a collection's search: the things scanned but not yet filed that are
// headed for THIS collection, each filed in one tap (#3823).
//
// A Voron scanned a minute ago sits in the inbox, not in 3D Printers, so a
// search of 3D Printers for "voron" came back empty and read as "you do not
// have one". The filed results stay first; this strip sits below them and
// shows only the rows whose destination is this collection. A row that is
// not ready to file (still being identified, or needing a look) links to its
// inbox card instead of offering an Add that would be refused.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { useToast } from "./ToastContext";
import { EntityPhoto } from "./EntityPhoto";

export function InboxWaitingStrip({ destination, q }: { destination: string; q: string }) {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(q.trim());
  useEffect(() => {
    const t = setTimeout(() => setText(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    // Under the inbox's own key, so every inbox write refreshes it.
    queryKey: ["scan-inbox", orgSlug, "waiting", destination, text],
    queryFn: () => api.waitingScans!(orgSlug, text, destination),
    enabled: !!api.waitingScans && !!orgSlug && text.length >= 2,
    staleTime: 10_000,
  });
  const file = useMutation({
    mutationFn: (id: string) => api.fileWaitingScan!(orgSlug, id),
    onSuccess: (r) => {
      toast.success(`Filed in ${r.label}.`);
      // The collection's own list gains the record, and the strip loses it.
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const items = found.data?.items ?? [];
  if (text.length < 2 || items.length === 0) return null;
  const total = found.data?.total ?? items.length;
  return (
    <section data-testid="inbox-waiting" className="mt-4 rounded-lg border border-dashed border-line dark:border-slate-700 p-3">
      <h3 className="text-sm font-semibold text-content dark:text-mortar-100">
        Waiting in your scan inbox ({total})
      </h3>
      <ul className="mt-2 divide-y divide-line dark:divide-slate-800">
        {items.map((it) => (
          <li key={it.id} data-testid="inbox-waiting-row" className="flex items-center gap-3 py-2">
            <EntityPhoto src={it.image} alt={it.name} size={40} className="rounded" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-content dark:text-mortar-100">{it.name}</div>
              {!it.canFile && it.reason && <div className="truncate text-xs text-muted dark:text-slate-400">{it.reason}</div>}
            </div>
            {it.canFile && api.fileWaitingScan ? (
              <button
                type="button"
                onClick={() => file.mutate(it.id)}
                disabled={file.isPending}
                className="shrink-0 rounded-md bg-cobble-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cobble-700 disabled:opacity-50"
              >
                {file.isPending && file.variables === it.id ? "Adding…" : "Add"}
              </button>
            ) : (
              <Link to={it.href} className="shrink-0 text-xs text-accent hover:underline">
                Open in inbox
              </Link>
            )}
          </li>
        ))}
      </ul>
      {total > items.length && (
        <Link to={`/scan`} className="mt-1 inline-block text-xs text-accent hover:underline">
          See all {total} in the scan inbox
        </Link>
      )}
    </section>
  );
}
