// The blocking result card the camera pops on every successful scan.
//
// A polished in-the-moment flow: scan → BLOCK → show the instant catalog
// match (name + photo, resolved server-side within the 12s budget) + a
// quantity stepper + one-tap routing into the best-fitting table. "Next"
// re-arms the scanner. The item lands in the inbox either way, so desktop
// triage still works; this just lets you set qty / commit on the spot.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, CheckCircle, MapPin, ScanLine, Sparkles, Trash2 } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type ScanCandidate, type ScanInboxItem, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useScanQuantity } from "../lib/scanQuantity";
import { CaptureSheetShell, QtyStepper } from "./ScanCaptureDrawer";
import { TrackedMatchBanner } from "../components/TrackedMatchBanner";
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
  item: itemProp,
  pending,
  scanArea,
  scanAreaId,
  getFrameBlob,
  scanTarget,
  onClose,
  onRetake,
  onEarly,
  moveMode,
  onAttached,
}: {
  barcode: string;
  /** The inbox row this sheet is about. The CAMERA PAGE owns the ingest and
   *  hands the row over when it lands (null while the lookup runs) — the sheet
   *  never creates anything, so closing it early can't lose the scan, and
   *  actions taken before the row exists can be queued by the page. Review
   *  mode passes the row immediately. */
  item?: ScanInboxItem | null;
  /** The page's ingest is still in flight ("Looking up…"). */
  pending?: boolean;
  /** The scanner session's area (a location name) — stamped on the item as
   *  `scan_area` at ingest, shown back in the card. */
  scanArea?: string | null;
  /** The area's location id — passed to confirm as `location_id` so a
   *  one-tap commit files the entity where you were standing. */
  scanAreaId?: string | null;
  /** The viewfinder frame captured at the scan moment, as a LOCAL preview
   *  while the server copies resolve. A promise because canvas.toBlob is
   *  async (reading a plain value lost the race). */
  getFrameBlob?: () => Promise<Blob | null> | null;
  scanTarget: CameraScanTarget;
  /** "handled" = the item left the pending state here (committed / attached /
   *  discarded / written onto the bin) — the camera clears its drawer.
   *  "dismissed" = "not now" (✕, swipe-down, Save & next): the item is still
   *  pending, so the camera collapses to the CLOSED drawer showing it — the
   *  mock's state-2 rule, "the item is saved either way". `current` is the
   *  freshest copy of the row for that drawer. */
  onClose: (outcome?: "handled" | "dismissed", current?: ScanInboxItem | null) => void;
  /** "Not it" — arm the shutter to RETAKE this item's photo, then close so
   *  the viewfinder is yours. The camera owns the arm. */
  onRetake?: (item: ScanInboxItem) => void;
  /** An action taken BEFORE the row exists (the author: "if I'm moving fast… I
   *  should be able to do that"). The page closes the sheet immediately and
   *  runs the intent the moment its ingest lands. */
  onEarly?: (intent: "discard" | "retake") => void;
  /** Move mode: a single exact "already tracked" barcode match
   *  auto-moves that entity to the active bin — no triage stop. */
  moveMode?: boolean;
  /** Fired after an attach (manual or auto-move) so the camera can offer undo. */
  onAttached?: (
    r: { itemId: string; prevLocationId: string | null; entityTitle: string },
    match: TrackedMatch,
    mode: "add-qty" | "link-barcode" | "move" | "merge-fields",
  ) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const aiStatus = useAiStatus();
  const qc = useQueryClient();
  const toast = useToast();

  const [item, setItem] = useState<ScanInboxItem | null>(itemProp ?? null);
  // Quantity + its write, together: this sheet used to hold the count in local
  // state and PATCH it only from "Save & next", so closing any other way threw
  // the edit away (the author, 2026-08-03). See lib/scanQuantity.
  const { value: qty, bump: bumpQty, flush: flushQty } = useScanQuantity(activeSlug, item);
  // URLs that 404'd/hotlink-blocked — each candidate gets one try, then we
  // fall to the next rung (a URL that failed once will fail again).
  const [brokenSrcs, setBrokenSrcs] = useState<ReadonlySet<string>>(new Set());
  // The page's ingest lands after mount — adopt the row once, then the live
  // poll below owns freshness.
  useEffect(() => {
    if (itemProp && !item) setItem(itemProp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemProp]);

  // LIVE-LOAD the enrichment: a slow lookup detaches past the ingest budget
  // and finishes in the background — keep polling the row while the card is
  // up so the name/photo pop in a second later instead of never (the same
  // lazy fill). Stops once the row looks final or after ~24s.
  // Enrichment is still plausibly running until the item is FULLY enriched (a
  // name AND a catalog image) or a generous window from scan time elapses. A
  // thin catalog hit stamps `ai_suggested_at` early while the web-search +
  // image-fetch tail (up to ~150s) is still resolving the real name/photo — so
  // ai_suggested_at alone is NOT "done", or the card stops polling + shows a
  // premature "No catalog match" while the real answer is still on its way.
  const enrichedFully =
    !!item?.suggested_name && (!!item?.catalog_image_file_id || !!item?.catalog_image_url);
  const withinEnrichWindow =
    !!item?.created_at && Date.now() - Date.parse(item.created_at) < 180_000;
  // The barcode result is being cross-checked against the user's own photo
  // (photo_check_pending, set by the enrich when a scan photo exists) or was
  // flagged as not matching it (photo_mismatch). While unverified, the card must
  // not lead with a possibly-wrong catalog picture — a collided/spam UPC resolves
  // to junk (an action figure over a yarn skein), and the race-fetched wrong image
  // reads as "the scanner failed". Lead with the user's photo instead.
  const modalMeta = (item?.suggested_metadata ?? {}) as {
    photo_check_pending?: boolean;
    photo_mismatch?: { reason?: string };
  };
  const photoCheckPending = modalMeta.photo_check_pending === true;
  const photoMismatch = !!modalMeta.photo_mismatch;
  // Keep the live poll going while the cross-check is unresolved, so the
  // "checking…" state flips to confirmed/corrected in-place (same 180s bound).
  const stillEnriching =
    !!item && (!enrichedFully || photoCheckPending) && withinEnrichWindow;
  const live = useQuery({
    queryKey: ["scan-item-live", activeSlug, item?.id],
    queryFn: () => api.getScanItem(activeSlug, item!.id),
    enabled: !!item?.id && stillEnriching,
    // 750ms cadence while enrichment is in flight: the by-name image search
    // measures ~500ms and the web-search tail lands mid-second, so a 2s poll
    // added up to 2s of "it is there but the card has not asked" - the scan
    // moment is exactly where that lag is felt. Single-row GET, bounded by the
    // 180s window above, so this self-stops. The hard cap is just a runaway
    // guard if that ever gets stuck.
    refetchInterval: (query) => (query.state.dataUpdateCount >= 260 ? false : 750),
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

  // Re-arm. The row already exists and the stepper already wrote the count —
  // flush covers a tap made inside the debounce window.
  const saveAndNext = () => {
    flushQty();
    onClose("dismissed", item ? { ...item, quantity: qty } : null);
  };

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
            Added - open{" "}
            <a href={dest} className="underline">
              {r.item.suggested_name ?? "the new entity"}
            </a>
          </span>
        ) : (
          `Added ${r.item.suggested_name ?? barcode}`
        )) as never,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose("handled");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Paired-scan: the scanned product IS the active bin. One tap writes the
  // product identity onto the bin's own location record (metadata.container_*,
  // catalog photo, description) — nothing new is created or filed.
  const intoBin = useMutation({
    mutationFn: () => api.confirmScanIntoLocation(activeSlug, item!.id, scanAreaId ?? undefined),
    onSuccess: () => {
      toast.success(`${scanArea ?? "Bin"} identified: ${item?.suggested_name ?? "container"}`);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
      onClose("handled");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose("handled");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // The viewfinder frame captured AT the scan moment, as a LOCAL object URL —
  // shown instantly (zero network) so the card never opens with a blank box
  // while the catalog image / server copy resolves; the better image swaps in
  // the moment it lands (the author).
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void Promise.resolve(getFrameBlob?.() ?? null)
      .then((b) => {
        if (cancelled || !b) return;
        url = URL.createObjectURL(b);
        setFrameUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // getFrameBlob is a stable ref-getter from the camera page; the frame is
    // fixed at open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const looking =
    (!!pending && !item) || (!!item && !item.suggested_name && !match.isFetched);
  // Catalog image first; the user's own photo as the fallback (photo scans
  // and barcode items that resolved without catalog art still get a face) —
  // EXCEPT while the catalog result is unverified against the user's photo
  // (checking, or a flagged mismatch): then the user's own photo leads, because
  // it is never wrong, and the catalog shot takes over once the check confirms.
  // External catalog_image_url can 404/hotlink-block (the broken-? the author hit)
  // — onError marks that URL broken and we drop to the next rung; the live
  // poll above may then land the server-cached catalog_image_file_id.
  const ownPhotoUrl = item?.image_file_id
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.image_file_id}/raw?variant=med`
    : null;
  const catalogRungs = [
    item?.catalog_image_file_id
      ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=med`
      : null,
    item?.catalog_image_url ?? null,
  ];
  const catalogImg =
    (photoCheckPending || photoMismatch
      ? [ownPhotoUrl, frameUrl, ...catalogRungs]
      : [...catalogRungs, ownPhotoUrl, frameUrl]
    ).find((u): u is string => !!u && !brokenSrcs.has(u)) ?? null;
  const areaLabel = item?.scan_area ?? scanArea ?? null;
  const busy = commit.isPending || discard.isPending || intoBin.isPending;

  return (
    // Deliberately NO onClose: no grip-dismiss, no swipe-down, no ✕. A barcode
    // result wants a decision — confirm it's right and move on (Save & next),
    // reject it (Discard), or hand the camera an arm. A gesture that silently
    // does one of those is how "what did the X do?" happens (the author, 2026-08-03:
    // "user needs to confirm or reject the result or at least move on").
    <CaptureSheetShell title="Scanned">
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
            {pending && !item ? (
              <div className="text-sm text-muted animate-pulse">Looking up…</div>
            ) : (
              <div className="font-medium text-content dark:text-mortar-100">
                {item?.suggested_name ?? (
                  stillEnriching ? (
                    <span className="text-faint italic animate-pulse">Identifying…</span>
                  ) : (
                    <span className="text-faint italic">No catalog match</span>
                  )
                )}
              </div>
            )}
            {!looking && item && !item.suggested_name && (
              <AiOffMissHint status={aiStatus} />
            )}
            {photoCheckPending && (
              <div className="text-[11px] text-accent animate-pulse mt-0.5 flex items-center gap-1">
                <Camera size={11} /> Checking this against your photo…
              </div>
            )}
            {!photoCheckPending && photoMismatch && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5 flex items-center gap-1">
                <Camera size={11} /> May not match your photo - double-check the name.
              </div>
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

        {/* Quantity — the LOCKED stepper (shared with the drawer), not a
            circles-and-input variant of its own. */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted">quantity</span>
          <QtyStepper value={qty} onBump={bumpQty} big />
        </div>

        {/* "Already tracked" — act on the EXISTING entity
            instead of duplicating; in Move mode a single exact barcode match
            auto-moves to the active bin and re-arms the camera. */}
        {item && item.status === "pending" && (
          <TrackedMatchBanner
            item={item}
            locationId={scanAreaId ?? null}
            locationName={scanArea ?? null}
            autoMove={moveMode}
            onAttached={(r, m, mode) => {
              onAttached?.(
                { itemId: item.id, prevLocationId: r.prev_location_id, entityTitle: r.entity_title },
                m,
                mode,
              );
              onClose("handled");
            }}
          />
        )}

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

        {/* Paired-scan: the bin's QR said WHICH record; this UPC says WHAT it
            is. Writes the product identity onto the active bin itself instead
            of filing a new item into it. Only offered when a location bin is
            active and the scan actually identified a product. */}
        {item && scanAreaId && item.suggested_name && (
          <button
            type="button"
            disabled={busy}
            onClick={() => intoBin.mutate()}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 text-content text-xs font-medium px-3 py-1.5 disabled:opacity-50"
          >
            <MapPin size={13} /> This is {areaLabel ?? "the bin"} itself - set its identity
          </button>
        )}

        {/* One camera action, one destructive action, one way out — and NONE
            of them wait for the lookup (the author: "if I'm moving fast and I want to
            take a nice pic instantly after scanning a barcode, I should be
            able to do that. same for discard."). Before the row lands the
            press goes through onEarly: the page closes the sheet NOW and runs
            the intent the moment its ingest returns.
            "Nice photo" is gone — the + shutter covers it: a barcode item's
            next shot becomes its display photo, a photo item's next shot joins
            the record. One button fewer, same power. */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => (item ? discard.mutate() : onEarly?.("discard"))}
            aria-label="Discard this scan"
            title="Discard this scan"
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg border border-line dark:border-slate-600 text-faint hover:text-ember-500 hover:border-ember-500 disabled:opacity-40"
          >
            <Trash2 size={16} />
          </button>
          {onRetake && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                item ? (onRetake(item), onClose("dismissed", item)) : onEarly?.("retake")
              }
              title="Photograph the item - the shutter arms, and vision re-identifies it from your shot"
              className="flex-1 h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-line dark:border-slate-600 text-content text-[12.5px] font-medium px-2 disabled:opacity-40"
            >
              <Camera size={14} /> Not it - retake
            </button>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={saveAndNext}
          className="w-full h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-[13px] font-semibold disabled:opacity-50"
        >
          <Check size={15} /> Save &amp; next
        </button>
      </div>
    </CaptureSheetShell>
  );
}
