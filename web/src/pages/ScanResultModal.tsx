// The blocking result card the camera pops on every successful scan.
//
// companion app-grade in-the-moment flow: scan → BLOCK → show the instant catalog
// match (name + photo, resolved server-side within the 12s budget) + a
// quantity stepper + one-tap routing into the best-fitting table. "Next"
// re-arms the scanner. The item lands in the inbox either way, so desktop
// triage still works; this just lets you set qty / commit on the spot.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle, Flag, MapPin, Minus, Plus, ScanLine, Sparkles, Trash2 } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type ScanCandidate, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { AiOffMissHint, useAiStatus } from "./ScanPage";

export interface CameraScanTarget {
  into: string | null;
  module: string | null;
  kind: string | null;
  label: string | null;
}

function candidateKind(c: ScanCandidate): string {
  return c.module === "assets" ? "asset" : c.module === "machines" ? "machine" : "part";
}

export function ScanResultModal({
  barcode,
  scanArea,
  scanAreaId,
  ensureBatchId,
  getFrameBlob,
  scanTarget,
  onSaved,
  onClose,
}: {
  barcode: string;
  /** The scanner session's area (a location name) — stamped on the item as
   *  `scan_area` at ingest, shown back in the card. */
  scanArea?: string | null;
  /** The area's location id — passed to confirm as `location_id` so a
   *  one-tap commit files the entity where you were standing. */
  scanAreaId?: string | null;
  /** Lazily mints the scanner session's shared scan_batch_id (single-flight
   *  in the caller). Omitted → un-batched. */
  ensureBatchId?: () => Promise<string | null>;
  /** The viewfinder frame captured at the scan moment — uploaded as the
   *  item's own photo (shown beside the catalog image at triage). A promise
   *  because canvas.toBlob is async (reading a plain value lost the race). */
  getFrameBlob?: () => Promise<Blob | null> | null;
  scanTarget: CameraScanTarget;
  onSaved: (item: ScanInboxItem) => void;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const aiStatus = useAiStatus();
  const qc = useQueryClient();
  const toast = useToast();

  const [item, setItem] = useState<ScanInboxItem | null>(null);
  const [qty, setQty] = useState(1);
  // URLs that 404'd/hotlink-blocked — each candidate gets one try, then we
  // fall to the next rung (a URL that failed once will fail again).
  const [brokenSrcs, setBrokenSrcs] = useState<ReadonlySet<string>>(new Set());
  const started = useRef(false);

  // Ingest the barcode on mount → the enriched row comes back (≤12s budget).
  const scan = useMutation({
    mutationFn: async () => {
      const frame = await (getFrameBlob?.() ?? null);
      const [batchId, frameFileId] = await Promise.all([
        ensureBatchId ? ensureBatchId() : Promise.resolve(null),
        frame
          ? api
              .uploadFile(
                activeSlug,
                new File([frame], `scan-${barcode}.jpg`, { type: "image/jpeg" }),
              )
              .then((f) => f.id)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      return api.scanBarcode(activeSlug, {
        barcode,
        scan_area: scanArea ?? undefined,
        target_location_id: scanAreaId ?? undefined,
        scan_batch_id: batchId ?? undefined,
        image_file_id: frameFileId ?? undefined,
      });
    },
    onSuccess: (it) => {
      setItem(it);
      setQty(it.quantity > 0 ? it.quantity : 1);
      onSaved(it);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    scan.mutate();
  }, [scan]);

  // LIVE-LOAD the enrichment: a slow lookup detaches past the ingest budget
  // and finishes in the background — keep polling the row while the card is
  // up so the name/photo pop in a second later instead of never (companion app does
  // the same lazy fill). Stops once the row looks final or after ~24s.
  const stillEnriching =
    !!item &&
    !item.ai_suggested_at &&
    (!item.suggested_name || (!item.catalog_image_file_id && !item.catalog_image_url));
  const live = useQuery({
    queryKey: ["scan-item-live", activeSlug, item?.id],
    queryFn: () => api.getScanItem(activeSlug, item!.id),
    enabled: !!item?.id && stillEnriching,
    // 2s cadence, capped — an item that will never enrich (no AI provider,
    // no catalog hit) shouldn't poll for as long as the card stays open.
    refetchInterval: (query) => (query.state.dataUpdateCount >= 12 ? false : 2_000),
    gcTime: 0,
  });
  useEffect(() => {
    const fresh = live.data;
    if (!fresh || !item) return;
    if (fresh.updated_at !== item.updated_at) setItem(fresh);
  }, [live.data, item]);

  // Once identified, ask the matchmaker which table(s) fit — shown as tap chips.
  const match = useQuery({
    queryKey: ["scan-match", activeSlug, item?.id],
    queryFn: () => api.matchScanItem(activeSlug, item!.id),
    enabled: !!item?.id && !!item?.suggested_name,
    staleTime: 60_000,
  });
  const candidates = (match.data?.candidates ?? []).slice(0, 3);

  // Save the quantity (if changed) and re-arm. The row already exists.
  const save = useMutation({
    mutationFn: async () => {
      if (!item) return null;
      if (qty !== item.quantity) {
        return api.updateScanItem(activeSlug, item.id, { quantity: qty });
      }
      return item;
    },
    onSuccess: (updated) => {
      if (updated) onSaved(updated);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // One-tap commit into a table (a matchmaker chip, or the ?into= target).
  const commit = useMutation({
    mutationFn: (opts: { module: string; kind: string; instance?: string; fields?: Record<string, unknown> }) => {
      if (!item) throw new ApiError(400, "no_item", "nothing to commit");
      const extras: Record<string, unknown> = {};
      if (item.suggested_manufacturer) extras.manufacturer = item.suggested_manufacturer;
      if (opts.fields && Object.keys(opts.fields).length) extras.metadata = opts.fields;
      return api.confirmScanItem(activeSlug, item.id, {
        target_module: opts.module,
        target_kind: opts.kind,
        instance: opts.instance,
        name: item.suggested_name ?? `Barcode ${barcode}`,
        quantity: qty > 0 ? qty : 1,
        // The scan area doubles as the putaway location on a one-tap
        // commit — you're filing the thing where you're standing.
        location_id: scanAreaId ?? undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      });
    },
    onSuccess: (r) => {
      const dest = r.item.target_module
        ? `/w/${activeSlug}/${r.item.target_module === "inventory" ? "inventory/parts" : r.item.target_module + "s"}/${r.created.id}`
        : null;
      toast.success(
        (dest ? (
          <span>
            Added — open{" "}
            <a href={dest} className="underline">
              {r.item.suggested_name ?? "the new entity"}
            </a>
          </span>
        ) : (
          `Added ${r.item.suggested_name ?? barcode}`
        )) as never,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Phone "Not right?" — re-ask everything (the same wrong-flag re-derive the
  // desktop triage uses). A barcode re-run is inline, so the response IS the
  // re-identified row; swap it straight in so the card updates on the spot.
  const rerunWrong = useMutation({
    mutationFn: () => api.rerunScanAi(activeSlug, item!.id, undefined, true),
    onSuccess: (fresh) => {
      setItem(fresh);
      setQty(fresh.quantity > 0 ? fresh.quantity : 1);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-match", activeSlug, fresh.id] });
      toast.success("Re-checked");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const looking = scan.isPending || rerunWrong.isPending || (!!item && !item.suggested_name && !match.isFetched);
  // Catalog image first; the user's own photo as the fallback (photo scans
  // and barcode items that resolved without catalog art still get a face).
  // External catalog_image_url can 404/hotlink-block (the broken-? the author hit)
  // — onError marks that URL broken and we drop to the next rung; the live
  // poll above may then land the server-cached catalog_image_file_id.
  const catalogImg =
    [
      item?.catalog_image_file_id
        ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=med`
        : null,
      item?.catalog_image_url ?? null,
      item?.image_file_id
        ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.image_file_id}/raw?variant=med`
        : null,
    ].find((u): u is string => !!u && !brokenSrcs.has(u)) ?? null;
  const areaLabel = item?.scan_area ?? scanArea ?? null;
  const busy = commit.isPending || save.isPending || discard.isPending || rerunWrong.isPending;

  return (
    <Modal open onClose={onClose} title="Scanned" size="sm">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-24 h-24 shrink-0 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center">
            {catalogImg ? (
              <img
                src={catalogImg}
                alt=""
                onError={() => setBrokenSrcs((prev) => new Set(prev).add(catalogImg))}
                className="w-full h-full object-cover"
              />
            ) : (
              <ScanLine
                size={24}
                className={stillEnriching ? "text-faint animate-pulse" : "text-faint"}
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {scan.isPending ? (
              <div className="text-sm text-muted animate-pulse">Looking up…</div>
            ) : (
              <div className="font-medium text-content dark:text-mortar-100">
                {item?.suggested_name ?? <span className="text-faint italic">No catalog match</span>}
              </div>
            )}
            {!scan.isPending && item && !item.suggested_name && (
              <AiOffMissHint status={aiStatus} />
            )}
            <div className="text-[11px] font-mono text-faint truncate">
              {barcode}
              {item?.suggested_manufacturer && ` · ${item.suggested_manufacturer}`}
            </div>
            {areaLabel && (
              <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted dark:text-slate-400">
                <MapPin size={11} className="text-accent shrink-0" /> {areaLabel}
              </div>
            )}
          </div>
        </div>

        {/* Quantity stepper — set the count once when holding a stack. */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted">quantity</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="rounded-full border border-line dark:border-slate-600 p-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800"
              aria-label="Decrease quantity"
            >
              <Minus size={14} />
            </button>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              className="w-14 text-center px-1 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
            />
            <button
              type="button"
              onClick={() => setQty((q) => q + 1)}
              className="rounded-full border border-line dark:border-slate-600 p-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800"
              aria-label="Increase quantity"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* One-tap routing: the ?into= target first, else matchmaker chips. */}
        {scanTarget.into ? (
          <button
            type="button"
            disabled={!item || busy}
            onClick={() =>
              commit.mutate({
                module: scanTarget.module ?? "inventory",
                kind: scanTarget.kind ?? "part",
                instance: scanTarget.into!,
              })
            }
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 disabled:opacity-50"
          >
            <CheckCircle size={15} /> Add to {scanTarget.label ?? scanTarget.into}
          </button>
        ) : candidates.length > 0 ? (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">
              add to
            </div>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((c, i) => (
                <button
                  key={`${c.module}:${c.instance ?? ""}:${i}`}
                  type="button"
                  disabled={!item || busy}
                  onClick={() =>
                    commit.mutate({
                      module: c.module,
                      kind: candidateKind(c),
                      instance: c.instance ?? undefined,
                      fields: c.fields,
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition border disabled:opacity-50 ${
                    i === 0
                      ? "bg-cobble-600 hover:bg-cobble-700 text-white border-cobble-600"
                      : "bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 text-content border-line dark:border-slate-700"
                  }`}
                >
                  <Sparkles size={11} /> {c.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          !looking &&
          item && (
            <div className="text-[11px] text-faint italic">
              {match.isFetching ? "finding the best table…" : "Saved to the inbox — triage it there."}
            </div>
          )
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={!item || busy}
            onClick={() => discard.mutate()}
            className="inline-flex items-center gap-1 text-xs text-faint hover:text-ember-500 disabled:opacity-40"
          >
            <Trash2 size={13} /> Discard
          </button>
          {/* Phone correct/wrong: if the ID looks off, re-check on the spot. */}
          {item && item.suggested_name && (
            <button
              type="button"
              disabled={busy}
              onClick={() => rerunWrong.mutate()}
              className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-40"
            >
              <Flag size={12} className={rerunWrong.isPending ? "animate-pulse" : ""} /> Not right?
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => (item ? save.mutate() : onClose())}
            className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 text-content hover:bg-subtle dark:hover:bg-slate-800 text-sm font-medium px-4 py-2"
          >
            <Check size={15} /> Save &amp; next
          </button>
        </div>
      </div>
    </Modal>
  );
}
