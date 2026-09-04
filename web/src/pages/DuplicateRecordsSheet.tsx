// Two rows for one thing, put back together.
//
//   #059  Roma Tomatoes    Kitchen   —              2026-08-25
//   #056  Tomatoes Roma    Kitchen   refrigerated   2026-09-06
//
// Scanned days apart, same two words. Reported with the line this sheet exists
// to answer: "nor should I have to" notice.
//
// WHY THIS ONE IS PER PAIR when everything else here batches. The question a
// merge asks is which of the two you keep, and that is genuinely per pair - the
// survivor keeps its id, its links and its history, and there is no honest way
// to answer that for thirty rows at once. So each pair gets one row, both names
// shown, and you press the one you are keeping.
//
// The button says KEEP, not merge, because that is the decision being made. The
// consequence is spelled out under it rather than left to be inferred.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy, Loader2, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { SidePanel } from "../components/SidePanel";

type Side = { id: string; title: string; qty: number | null; location_id: string | null };

/** What one side of a pair says about itself, under its name. */
function sideDetail(side: Side, locationName: (id: string | null) => string | null): string {
  const bits: string[] = [];
  if (side.qty !== null) bits.push(`${side.qty} on hand`);
  const where = locationName(side.location_id);
  if (where) bits.push(where);
  return bits.join(" · ");
}

export function DuplicateRecordsSheet({
  slug,
  onClose,
  locationName = () => null,
}: {
  slug: string;
  onClose: () => void;
  /** Resolves a location id to its name, when the caller has them loaded. */
  locationName?: (id: string | null) => string | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busyPair, setBusyPair] = useState<string | null>(null);

  const dupes = useQuery({
    queryKey: ["scan-duplicates", slug],
    queryFn: () => api.scanDuplicates(slug),
    staleTime: 30_000,
  });

  const merge = useMutation({
    mutationFn: (v: { kind: string; keep_id: string; drop_id: string }) =>
      api.scanMergeDuplicate(slug, v),
    onSuccess: (r) => {
      const qty = r.new_qty !== null ? `, now ${r.new_qty}` : "";
      const filled = r.filled.length ? `, kept ${r.filled.length} detail${r.filled.length === 1 ? "" : "s"} from it` : "";
      toast.success(`Merged into ${r.kept.title}${qty}${filled}`);
      void qc.invalidateQueries({ queryKey: ["scan-duplicates", slug] });
      // The tables these rows live in are somebody else's queries; a merge
      // changed one of them, so nothing on screen may keep showing the row that
      // is gone.
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
    onSettled: () => setBusyPair(null),
  });

  const pairs = dupes.data?.pairs ?? [];

  return (
    <SidePanel width="30rem">
      <div className="flex items-center justify-between border-b border-line/70 dark:border-slate-700/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <Copy size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
            Same thing twice
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-muted hover:bg-subtle dark:hover:bg-slate-800"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {dupes.isPending && (
          <p className="flex items-center gap-2 text-[13px] text-muted dark:text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Looking through your records…
          </p>
        )}

        {dupes.isError && (
          <p className="text-[13px] text-rose-600 dark:text-rose-400">
            {dupes.error instanceof ApiError ? dupes.error.message : "Could not read your records."}
          </p>
        )}

        {!dupes.isPending && !dupes.isError && pairs.length === 0 && (
          <p className="text-[13px] text-muted dark:text-slate-400">
            Nothing looks duplicated. New scans that match something you already have are added to
            it rather than filed again, so this should stay empty.
          </p>
        )}

        {pairs.length > 0 && (
          <p className="mb-3 text-[12.5px] text-muted dark:text-slate-400">
            These look like the same thing under two names. Keep one and the other is added to it:
            the quantities are combined and anything the kept record is missing is taken from the
            other.
          </p>
        )}

        <ul className="space-y-3">
          {pairs.map((p) => {
            const pairKey = `${p.kind}:${p.a.id}:${p.b.id}`;
            const busy = busyPair === pairKey;
            const keep = (keepSide: Side, dropSide: Side) => {
              setBusyPair(pairKey);
              merge.mutate({ kind: p.kind, keep_id: keepSide.id, drop_id: dropSide.id });
            };
            return (
              <li
                key={pairKey}
                className="rounded-lg border border-line/70 dark:border-slate-700/70 p-3"
              >
                <p className="mb-2 text-[11.5px] uppercase tracking-wide text-muted dark:text-slate-400">
                  {p.noun} · both say {p.shared.join(", ")}
                </p>
                {[
                  { mine: p.a, other: p.b },
                  { mine: p.b, other: p.a },
                ].map(({ mine, other }) => (
                  <div
                    key={mine.id}
                    className="flex items-center justify-between gap-3 border-t border-line/50 dark:border-slate-700/50 py-2 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-content dark:text-mortar-100">
                        {mine.title}
                      </p>
                      <p className="truncate text-[11.5px] text-muted dark:text-slate-400">
                        {sideDetail(mine, locationName) || "no details"}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => keep(mine, other)}
                      title={`Keep ${mine.title} and add ${other.title} to it`}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-line/70 dark:border-slate-700/70 px-2 py-1 text-[11.5px] font-medium text-content dark:text-mortar-100 hover:border-cobble-400 disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                      Keep this one
                    </button>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>

        {dupes.data?.truncated && (
          <p className="mt-3 text-[12px] text-muted dark:text-slate-400">
            Showing the first {pairs.length}. Merge some and look again for the rest.
          </p>
        )}
      </div>
    </SidePanel>
  );
}
