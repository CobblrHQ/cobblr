// What your scanner brought in that has somewhere to go, at the top of the
// dashboard: "2 look like Groceries, Create Groceries & file all 2", with the
// person's own photos, one press per table.
//
// This is THE surface for "you've scanned things that fit a table you don't
// have yet" (#3298). The dashboard used to say that three times in three
// voices: a put-away nag counting the same scans as homeless, a card of
// install chips (later a one-sentence pointer) above, and this lane far below
// the fold inside the What-do-you-want-to-do panel. Walked on a fresh
// workspace with three scans, the lane was the one a stranger could act on
// (it has their photos and a sentence saying what will happen) and it read
// last. So it moved up here and the card went; the put-away nag now counts
// only what this queue cannot place (ScannerNagRow).
//
// Bounded: at most `cap` groups, biggest first, and a line saying how many
// more wait in the Scan Inbox. A band above the whole dashboard must not be
// sized by however many tables happened to match.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { useNavigate } from "react-router-dom";
import { api, type ScanInboxItem, type ScannerQueueSummary } from "../lib/api";
import { useMaterializeCapture } from "../lib/useMaterializeCapture";
import { CaptureTile } from "./CaptureTile";

export interface ScanGroup {
  key: string;
  label: string;
  /** Set when the match is a bundle not installed yet (Create & file). */
  bundleId?: string;
  /** Set when the match is a table that exists (Add all N to). */
  target?: { module: string; kind: string; instance?: string };
  /** Every pending scan in the group, over the whole inbox: what its button
   *  counts and exactly what it files. */
  ids: string[];
  /** The group's scans the loaded page holds, for the thumbnails only. */
  preview: ScanInboxItem[];
}

export interface ScannerQueueState {
  /** Every pending scan that came from the scanner (not typed), all of them. */
  total: number;
  /** Scans with a home to offer, grouped by it, biggest first. */
  groups: ScanGroup[];
  /** Scans nothing here can place: unmatched, or still being read. */
  residual: number;
  /** The scans the groups account for (what the put-away nag leaves out). */
  offered: number;
}

/** The server's queue (core-scan services/scanner-queue.ts, every pending
 *  scan) with the loaded page's rows as thumbnails. Every count and every id a
 *  button files comes from the summary; the page only lends pictures, so a
 *  queue longer than a page is never counted as the page (#3598). */
export function queueFromServer(summary: ScannerQueueSummary, page: readonly ScanInboxItem[]): ScannerQueueState {
  const byId = new Map(page.map((i) => [i.id, i]));
  const groups = summary.groups.map((g) => ({
    key: g.key,
    label: g.label,
    ...(g.bundle_external_id ? { bundleId: g.bundle_external_id } : {}),
    ...(g.target ? { target: g.target } : {}),
    ids: g.item_ids,
    preview: g.item_ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
  }));
  return { total: summary.scanned_total, groups, residual: summary.residual, offered: summary.offered };
}

const EMPTY: ScannerQueueSummary = { scanned_total: 0, groups: [], residual: 0, offered: 0 };

/** The pending inbox, grouped by where each scan could go, counted over all of
 *  it. One read feeds the queue and the put-away nag beside it, so the two
 *  cannot disagree. */
export function useScannerQueue(slug: string): ScannerQueueState {
  const summary = useQuery({
    queryKey: ["scanner-queue", slug],
    queryFn: () => api.scanScannerQueue(slug),
    enabled: !!slug,
    refetchInterval: (q) => ((q.state.data?.scanned_total ?? 0) > 0 ? 4000 : 20000),
  });
  const page = useQuery({
    queryKey: ["capture-inbox", slug],
    queryFn: () => api.listScanInbox(slug, { status: "pending" }),
    enabled: !!slug && (summary.data?.offered ?? 0) > 0,
    refetchInterval: 20000,
  });
  return useMemo(() => queueFromServer(summary.data ?? EMPTY, page.data?.items ?? []), [summary.data, page.data]);
}

export function ScannerQueue({ slug, queue, cap = 2 }: { slug: string; queue: ScannerQueueState; cap?: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const materialize = useMaterializeCapture(slug);
  // "Add all N to <existing table>": sequential confirms (small groups; no bulk
  // endpoint needed).
  const confirmGroup = useMutation({
    mutationFn: async (g: { label: string; target: { module: string; kind: string; instance?: string }; ids: string[] }) => {
      for (const id of g.ids) {
        await api.confirmScanItem(slug, id, { target_module: g.target.module, target_kind: g.target.kind, ...(g.target.instance ? { instance: g.target.instance } : {}) });
      }
      return g;
    },
    onSuccess: (g) => {
      void qc.invalidateQueries();
      toast.success(`Filed ${g.ids.length} into ${g.label}.`);
      if (g.target.instance) navigate(`/instances/${g.target.instance}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't file those"),
  });
  if (queue.groups.length === 0) return null;
  const shown = queue.groups.slice(0, cap);
  const more = queue.groups.length - shown.length;
  const moreScans = queue.groups.slice(cap).reduce((n, g) => n + g.ids.length, 0);
  return (
    <section data-testid="scanner-queue" className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">// from your scanner - waiting to file ({queue.total})</span>
        <div className="flex-1" />
        <Link to="/scan" className="text-xs text-accent hover:underline shrink-0">
          review all in the Scan Inbox →
        </Link>
      </div>
      <ul className="space-y-1.5">
        {shown.map((g) => {
          const busy = g.bundleId ? materialize.busy(g.bundleId) : confirmGroup.isPending && confirmGroup.variables?.label === g.label;
          return (
            <li key={g.key} data-testid="scanner-queue-group" className="rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/15 px-3 py-2.5 space-y-1.5">
              {/* Header row: count/label + a compact inline CTA; the tile strip
                  below gets the full card width. */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0 text-sm text-content dark:text-mortar-100">
                  <strong>{g.ids.length}</strong> look{g.ids.length === 1 ? "s" : ""} like <span className="text-accent font-medium">{g.label}</span>
                </div>
                {g.bundleId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => materialize.start(g.bundleId!, g.ids)}
                    className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                    Create {g.label} & file all {g.ids.length}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => confirmGroup.mutate({ label: g.label, target: g.target!, ids: g.ids })}
                    className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                    Add all {g.ids.length} to {g.label}
                  </button>
                )}
              </div>
              {/* Full-width tile strip: the person's own scans, so they know it is
                  their thing being offered a home. */}
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {g.preview.slice(0, 12).map((i) => (
                  <CaptureTile key={i.id} slug={slug} it={i} />
                ))}
                {g.ids.length > Math.min(12, g.preview.length) && (
                  <Link to="/scan" className="flex-1 min-w-14 max-w-24 aspect-square rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 grid place-items-center text-xs font-medium text-muted dark:text-slate-300 hover:border-accent hover:text-accent transition">
                    +{g.ids.length - Math.min(12, g.preview.length)}
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Link to="/scan" data-testid="scanner-queue-more" className="block rounded-lg border border-line dark:border-slate-800 bg-surface dark:bg-slate-900 px-3 py-2 text-xs text-muted dark:text-slate-400 hover:text-accent hover:border-accent transition">
          {moreScans} more scan{moreScans === 1 ? "" : "s"} fit {more} other table{more === 1 ? "" : "s"} - review in the Scan Inbox →
        </Link>
      )}
      {materialize.modal}
    </section>
  );
}
