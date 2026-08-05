// The capture drawer — the camera's ONE "what just happened" surface
// (docs mock: _tmp/scan-capture-drawer.html; the author, 2026-08-02).
//
// Rapid capture works because nothing asks anything: shoot → keep walking. But
// four needs kept pulling people out of it (check the shot was good, label
// shot then display shot, "I have 3 of these", fix the location after). The
// answers used to be spread over THREE take-turns surfaces — the top-of-frame
// "photo saved" note, the last-saved pill, the failed-shot retry pill — none
// of which showed the photo. This drawer replaces all three: one persistent
// card above the shutter whose CONTENTS swap on every capture.
//
// Rules it holds:
//  · It may never require a tap. Ignoring it forever = today's rhythm.
//  · It never covers the shutter row (the standing rule; see the savedNote
//    comment that used to live here for why the bottom slot is precious).
//  · The thumbnail is the LOCAL frame, drawn before the upload finishes, so
//    "was that good?" is answerable instantly, offline, mid-burst.
//  · A failed save renders HERE (retry/discard), not as a separate pill.
//
// The quantity stepper is the same − N + shape as ScanResultModal's, PATCHed
// debounced so mashing + doesn't stack requests.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, ChevronDown, Loader2, MapPin, Minus, Plus, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { useImageSrc } from "@cobblr/platform-web";
import { api, type ScanInboxItem } from "../lib/api";
import { useScanQuantity } from "../lib/scanQuantity";
import { leadPhoto } from "../lib/scanPhoto";
import { useAnimatedHeight } from "../lib/useAnimatedHeight";

/** How long a photo item may sit un-named before we stop saying "identifying…"
 *  (mirrors the inbox's own stale rule). */
const IDENTIFY_WINDOW_MS = 60_000;

/** Vertical swipe on a sheet: up opens, down collapses/dismisses (the mock's
 *  grip + "swipe up for more"). A swipe that starts in an input/textarea is
 *  ignored — dragging while editing a name must not fling the sheet away —
 *  and a mostly-horizontal move is not a swipe. Tap targets keep working:
 *  a real tap never travels the 42px threshold. */
function useSheetSwipe(onUp?: () => void, onDown?: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      // Only an input being EDITED blocks the gesture - an unfocused field is
      // just surface under the thumb, and treating every field as a dead zone
      // made most of the sheet unswipable.
      const el = e.target as HTMLElement;
      const field = el.closest("input,textarea,select");
      if (!t || (field && field === document.activeElement)) {
        start.current = null;
        return;
      }
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current;
      start.current = null;
      const t = e.changedTouches[0];
      if (!s || !t) return;
      const dy = t.clientY - s.y;
      if (Math.abs(dy) < 42 || Math.abs(t.clientX - s.x) > Math.abs(dy)) return;
      if (dy < 0) onUp?.();
      else onDown?.();
    },
  };
}

/** The locked quantity stepper (the mock's wire shape): one bordered group,
 *  [−  N  +], thumb-sized buttons, no free-text input. SHARED by the drawer,
 *  the expanded sheet and the barcode result so the shape can't drift again
 *  (the author, 2026-08-03: the result card had grown its own circles-and-input
 *  variant). `big` pads the buttons up for the primary sheets. */
export function QtyStepper({
  value,
  onBump,
  big,
  testId,
}: {
  value: number;
  onBump: (d: 1 | -1) => void;
  big?: boolean;
  testId?: string;
}) {
  const pad = big ? "px-4 py-2.5" : "px-3 py-1.5";
  return (
    <div className="flex items-center rounded-lg border border-white/25 bg-white/10 overflow-hidden shrink-0">
      <button type="button" onClick={() => onBump(-1)} aria-label="Fewer" disabled={value <= 1} className={`${pad} text-white disabled:opacity-40`}>
        <Minus size={big ? 15 : 13} />
      </button>
      <span data-testid={testId} className={`min-w-[1.9rem] text-center text-white font-bold ${big ? "text-[14.5px]" : "text-[13px]"}`}>
        {value}
      </span>
      <button type="button" onClick={() => onBump(1)} aria-label="More" className={`${pad} text-white`}>
        <Plus size={big ? 15 : 13} />
      </button>
    </div>
  );
}

/** The mock's grip bar — the sheet's handle. Tappable when given an action. */
function Grip({ onTap, label }: { onTap?: () => void; label?: string }) {
  const bar = <div className="h-1 w-9 rounded-full bg-white/35 mx-auto" />;
  if (!onTap) return <div className="pt-2 pb-1">{bar}</div>;
  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={label ?? "Collapse"}
      className="block w-full pt-2 pb-1"
    >
      {bar}
    </button>
  );
}

export function ScanCaptureDrawer({
  slug,
  item,
  localFrameUrl,
  localFrameItemId,
  sessionCount,
  batchId,
  failed,
  onUndo,
  undoBusy,
  onConfirm,
  onDismiss,
  onAddPhoto,
  onRetake,
  armed,
  onCancelArm,
  onPickLocation,
  sessionLocationLabel,
  containerLabel,
  onExpandedChange,
  collapseNonce,
  onExpandBarcode,
}: {
  slug: string;
  /** The most recent save this session (photo or barcode), or null. */
  item: ScanInboxItem | null;
  /** Object URL of the last shutter frame — shown the instant it's captured. */
  localFrameUrl: string | null;
  /** The item the local frame belongs to (null while its save is in flight). */
  localFrameItemId: string | null;
  sessionCount: number;
  batchId: string | null;
  /** A shutter save that failed — the frame survives for retry. */
  failed: { retry: () => void; discard: () => void; busy: boolean } | null;
  onUndo: (item: ScanInboxItem) => void;
  undoBusy: boolean;
  /** CONFIRM — the platform's verb for filing an inbox item into its
   *  destination (api.confirmScanItem). Files, then hides the drawer. */
  onConfirm: (item: ScanInboxItem) => void;
  /** Hide WITHOUT filing — the item stays pending in the inbox. */
  onDismiss: () => void;
  /** Arm the shutter to APPEND its next frame to this item (label shot, then
   *  the display shot, on one record). */
  onAddPhoto: (item: ScanInboxItem) => void;
  /** Arm the shutter to REPLACE this item's photo and read it again. */
  onRetake: (item: ScanInboxItem) => void;
  /** Which arm is live, so the drawer can say so and offer a way out. */
  armed: "append" | "retake" | "catalog" | null;
  onCancelArm: () => void;
  /** Open the per-item location override (its own layer — a full picker can't
   *  fit inside a sheet that isn't allowed to scroll). */
  onPickLocation: (item: ScanInboxItem) => void;
  /** The session's stamp, shown as what an un-overridden item inherits. */
  sessionLocationLabel: string | null;
  /** A container bin is armed → the item files INTO it, not into a location. */
  containerLabel: string | null;
  /** The page needs to know when the sheet is open: it dims the viewfinder
   *  behind it and PAUSES barcode detection (a code drifting into frame while
   *  you edit would flip to the result phase and unmount this sheet). */
  onExpandedChange?: (open: boolean) => void;
  /** Bumped by the page to ask for the expanded sheet to collapse (the +
   *  shutter puts every sheet away before arming). */
  collapseNonce?: number;
  /** A BARCODE item expands into the same "Scanned" sheet it was born in
   *  (review mode - no re-scan), never the photo sheet. One item, one sheet:
   *  the author counted three different drawers for one scanned item (2026-08-03). */
  onExpandBarcode?: (item: ScanInboxItem) => void;
}) {
  const qc = useQueryClient();

  // Identity fills in where the spinner was: poll the single item while it's
  // still nameless and fresh. recent[] is a snapshot from save time, so
  // without this the drawer would say "identifying…" forever.
  const wantsPoll =
    !!item &&
    !item.suggested_name &&
    !item.ai_suggested_at &&
    Date.now() - new Date(item.created_at).getTime() < IDENTIFY_WINDOW_MS;
  const live = useQuery({
    queryKey: ["scan-item-live", slug, item?.id],
    queryFn: () => api.getScanItem(slug, item!.id),
    enabled: wantsPoll,
    refetchInterval: (q) => (q.state.data?.suggested_name || q.state.data?.ai_suggested_at ? false : 2500),
  });
  // Prefer whichever copy is newer: the poll can hold a snapshot from before an
  // append/retake, and the prop carries the server's response to that very call.
  const it =
    live.data && item && new Date(live.data.updated_at) >= new Date(item.updated_at)
      ? live.data
      : (item ?? live.data);

  // Quantity: optimistic local value, debounced PATCH (mashing + must not
  // stack requests). Resets whenever the drawer's subject changes.
  const [expanded, setExpandedState] = useState(false);
  const setExpanded = (v: boolean) => {
    setExpandedState(v);
    onExpandedChange?.(v);
  };
  useEffect(() => {
    setExpandedState(false); // a new capture always starts closed — never interrupt the burst
    onExpandedChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, collapseNonce]);
  // Declared with the other hooks: the failed-save branch returns early below.
  const slide = useAnimatedHeight<HTMLDivElement>();
  const openSheet = () => {
    if (!it || failed || armed) return;
    if (it.source_kind !== "photo" && onExpandBarcode) onExpandBarcode(it);
    else setExpanded(true);
  };
  const swipe = useSheetSwipe(
    () => {
      if (!expanded) openSheet();
    },
    () => {
      // Down on the open sheet collapses it; down on the CLOSED drawer is
      // "I'm done with this one" - same as the ✕ (it stays in the inbox).
      if (expanded) setExpanded(false);
      else onDismiss();
    },
  );
  const rename = useMutation({
    mutationFn: (name: string) => api.updateScanItem(slug, item!.id, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      void qc.invalidateQueries({ queryKey: ["scan-item-live", slug, item?.id] });
    },
  });
  const photo = useMutation({
    mutationFn: (v: { op: "primary" | "remove"; fileId: string }) =>
      v.op === "primary"
        ? api.setScanPrimaryPhoto(slug, item!.id, v.fileId)
        : api.removeScanPhoto(slug, item!.id, v.fileId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      void qc.invalidateQueries({ queryKey: ["scan-item-live", slug, item?.id] });
    },
  });
  // The quantity and its persistence come as one thing — see lib/scanQuantity.
  const { value: shownQty, bump } = useScanQuantity(slug, it ?? null);

  if (!failed && !it) return null;

  // ── failed save: the frame survives, retry lives where the eye already is ──
  if (failed) {
    return (
      <div
        data-testid="capture-drawer-failed"
        className="max-w-md mx-auto rounded-2xl border border-amber-400/60 bg-black/70 backdrop-blur-md overflow-hidden"
      >
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Thumb url={localFrameUrl} name="photo" />
          <div className="flex-1 min-w-0">
            <div className="text-white text-[13px] font-semibold truncate">Photo didn&apos;t save</div>
            <div className="text-amber-300 text-[11px]">still here - retry when you have signal</div>
          </div>
          <button
            type="button"
            disabled={failed.busy}
            onClick={failed.retry}
            className="inline-flex items-center gap-1 rounded-lg bg-amber-400 text-slate-900 text-xs font-semibold px-3 py-2 disabled:opacity-50 shrink-0"
          >
            {failed.busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Retry
          </button>
          <button
            type="button"
            onClick={failed.discard}
            aria-label="Discard failed photo"
            className="p-1.5 rounded-full text-white/70 hover:text-white hover:bg-white/10 shrink-0"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  // ── the normal row: thumbnail · identity · quantity ───────────────────────
  const isPhoto = it!.source_kind === "photo";
  const name = it!.suggested_candidates?.[0]?.name || it!.suggested_name;
  const identifying =
    isPhoto && !name && !it!.ai_suggested_at &&
    Date.now() - new Date(it!.created_at).getTime() < IDENTIFY_WINDOW_MS;
  // Identify FINISHED (or timed out) with no name. Saying so is the whole
  // point of the drawer — "identifying…" that silently becomes "Captured
  // item" reads as the resolution having been eaten (the author, 2026-08-03). The
  // sheet's name field is one swipe away.
  const identifyFailed = isPhoto && !name && !identifying;
  // Interplay rule from the mock: with a container bin armed the line reads
  // "Into <container>" — it's a container target, not a location id.
  const dest =
    it!.suggested_candidates?.[0]?.label ??
    it!.scan_area ??
    (containerLabel ? `Into ${containerLabel}` : null);
  // Local frame beats everything for a PHOTO item (never swap away from the
  // user's own shot). A barcode item falls through its file-backed sources:
  // display photo (which the + shutter may have just written - the thumb went
  // BLANK after a + snap because only catalog_image_url was consulted), then
  // provider art, then the scan-moment frame.
  const fileThumb = (id: string) => `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw?variant=thumb`;
  // The local frame still wins outright (it is THIS capture, already on screen,
  // and needs no round trip). Past that, the shared rule decides — including
  // holding back catalog art that is still being cross-checked.
  const thumbUrl =
    localFrameItemId === it!.id && localFrameUrl
      ? localFrameUrl
      : leadPhoto(it!, {
          catalog: isPhoto
            ? []
            : [it!.catalog_image_file_id ? fileThumb(it!.catalog_image_file_id) : null, it!.catalog_image_url ?? null],
          yours: it!.image_file_id ? fileThumb(it!.image_file_id) : null,
        }).src;

  return (
    <div
      data-testid="capture-drawer"
      {...swipe}
      // The height is driven, not natural, so tall <-> short is a slide rather
      // than a pop; overflow-hidden is what clips the taller contents mid-slide.
      style={slide.style}
      className="relative max-w-md mx-auto rounded-2xl border border-white/15 bg-black/70 backdrop-blur-md overflow-hidden"
    >
      <div ref={slide.innerRef}>
      {expanded ? (
        <ExpandedSheet
          slug={slug}
          it={it!}
          name={name}
          shownQty={shownQty}
          bump={bump}
          onCollapse={() => setExpanded(false)}
          onRename={(v) => rename.mutate(v)}
          onPhoto={(op, fileId) => photo.mutate({ op, fileId })}
          photoBusy={photo.isPending}
          onAddPhoto={() => { setExpanded(false); onAddPhoto(it!); }}
          onPickLocation={() => onPickLocation(it!)}
          sessionLocationLabel={sessionLocationLabel}
          containerLabel={containerLabel}
          onConfirm={() => onConfirm(it!)}
          onDelete={() => onUndo(it!)}
          deleteBusy={undoBusy}
        />
      ) : (
      <>
      {/* Not ready to file it? ✕ just hides — it stays pending in the inbox. */}
      <button
        type="button"
        onClick={onDismiss}
        data-testid="capture-drawer-dismiss"
        aria-label="Hide this, leave it in the inbox"
        className="absolute top-1 right-1 p-1.5 rounded-full text-white/45 hover:text-white hover:bg-white/10"
      >
        <X size={13} />
      </button>
      {/* The grip: the sheet's handle — swipe up (or tap it / the identity
          row) for the full sheet. The hint under it is the mock's copy. */}
      {!armed && <Grip onTap={openSheet} label="Open the full sheet" />}
      {!armed && (
        <div className="text-center text-[10px] text-white/30 leading-none pb-0.5">
          swipe up for more
        </div>
      )}
      {/* TWO rows on purpose. Everything on one line left the name ~48px at
          phone width ("Ca…"): thumb + stepper + Confirm + the ✕ gutter eat
          310 of 374. The identity gets a full-width line; the controls get
          their own, with Confirm still in the right-thumb corner. */}
      <div
        role="button"
        tabIndex={0}
        onClick={openSheet}
        onKeyDown={(e) => { if (e.key === "Enter") openSheet(); }}
        className="flex items-start gap-2.5 px-3 pt-1.5 pr-8 cursor-pointer"
      >
        <Thumb url={thumbUrl} name={name ?? "item"} />
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="text-white text-[13.5px] font-semibold leading-tight line-clamp-2">
            {name ?? (identifying ? "Photo saved" : identifyFailed ? "Couldn't identify" : "Captured item")}
          </div>
          <div className="text-white/60 text-[11px] truncate mt-0.5">
            {armed ? (
              <span className="text-cobble-300 font-medium">
                {armed === "append"
                  ? "next shot joins this one"
                  : armed === "catalog"
                    ? "next shot becomes its photo"
                    : "next shot replaces the photo"}
              </span>
            ) : identifying ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={10} className="animate-spin" /> identifying…
              </span>
            ) : identifyFailed ? (
              <span className="text-amber-300">swipe up to name it</span>
            ) : dest ? (
              // A hint about where it will probably end up, not a claim that
              // the camera put it there — everything here is in the inbox.
              <>in your scan inbox · looks like {dest}</>
            ) : (
              "in your scan inbox"
            )}
          </div>
        </div>
      </div>
      {armed ? (
        <div className="flex items-center gap-2 px-3 pt-2 pb-2.5">
          <span className="text-[11px] text-cobble-300 flex-1 min-w-0">
            {armed === "append"
              ? "taking another photo for this item - press the shutter"
              : armed === "catalog"
                ? "the next shot becomes its photo - press the shutter"
                : "retaking its photo - press the shutter"}
          </span>
          <button
            type="button"
            onClick={onCancelArm}
            data-testid="capture-drawer-cancel-arm"
            className="inline-flex items-center gap-1 rounded-lg border border-white/25 text-white text-[12.5px] px-3 py-1.5 shrink-0"
          >
            <X size={12} /> Cancel
          </button>
        </div>
      ) : (
      <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
        <QtyStepper value={shownQty} onBump={bump} testId="capture-drawer-qty" />
        <div className="flex-1" />
        {/* The right slot is where the thumb lands, so it belongs to the action
            you take every time. It is an affirmative "I looked, it's right" that
            clears the drawer — it does NOT file (the scanner never files; that
            happens in the inbox). Not "Done" either: the shutter row's ✓ Done
            (which exits to the inbox) sits ~40px below, and two Dones that deep
            in muscle memory is a mis-tap. */}
        <button
          type="button"
          onClick={() => onConfirm(it!)}
          data-testid="capture-drawer-confirm"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-[13px] font-semibold px-4 py-2 shrink-0 disabled:opacity-50"
        >
          <Check size={14} /> Looks right
        </button>
      </div>
      )}
      {/* Secondary taps, deliberately small and LEFT: Undo is urgent but rare
          (a mis-scan), and putting it under the stepper — the other candidate —
          would sit it right where the thumb bounces after tapping +. */}
      {!armed && (
        <div className="flex items-center gap-3 px-3 pb-1 text-[11.5px]">
          <button
            type="button"
            disabled={undoBusy}
            onClick={() => onUndo(it!)}
            className="inline-flex items-center gap-1 py-0.5 text-white/70 hover:text-white disabled:opacity-50"
          >
            <Undo2 size={12} /> Undo
          </button>
          <button
            type="button"
            onClick={() => onAddPhoto(it!)}
            data-testid="capture-drawer-addphoto"
            className="inline-flex items-center gap-1 py-0.5 text-white/70 hover:text-white"
          >
            <Plus size={12} /> Photo
          </button>
          <button
            type="button"
            onClick={() => onRetake(it!)}
            data-testid="capture-drawer-retake"
            className="inline-flex items-center gap-1 py-0.5 text-white/70 hover:text-white"
          >
            <RefreshCw size={11} /> Retake
          </button>
        </div>
      )}
      </>
      )}
      <div className="flex items-center gap-2 px-3 pb-2 text-[11px] text-white/50">
        <span>{sessionCount} this session</span>
        <span aria-hidden>·</span>
        <Link to={batchId ? `/scan#s-${batchId}` : "/scan"} className="text-cobble-300 hover:text-cobble-200">
          Open inbox →
        </Link>
      </div>
      </div>
    </div>
  );
}

function Thumb({ url, name }: { url: string | null; name: string }) {
  // File-served sources need the auth token; object URLs and external catalog
  // art load plain.
  const resolved = useImageSrc(url && url.startsWith("/api/") ? url : null) ?? (url && !url.startsWith("/api/") ? url : null);
  return (
    <div className="w-[52px] h-[52px] rounded-lg border border-white/20 bg-white/5 overflow-hidden grid place-items-center shrink-0">
      {resolved ? (
        <img src={resolved} alt={name} className="w-full h-full object-cover" />
      ) : (
        <Camera size={18} className="text-white/40" />
      )}
    </div>
  );
}

/** The drawer, opened. Everything the barcode result offers, for an item that
 *  had no barcode — plus the gallery, so the label shot and the display shot
 *  live on one record and you choose the cover.
 *
 *  It must FIT: no inner scroll, nothing clipped, and it never reaches the
 *  shutter row. That is why the location picker opens as its own layer rather
 *  than inline — a full picker cannot coexist with these fields in the height
 *  available above the shutter. */
function ExpandedSheet({
  slug, it, name, shownQty, bump, onCollapse, onRename, onPhoto, photoBusy,
  onAddPhoto, onPickLocation, sessionLocationLabel, containerLabel,
  onConfirm, onDelete, deleteBusy,
}: {
  slug: string;
  it: ScanInboxItem;
  name: string | null | undefined;
  shownQty: number;
  bump: (d: 1 | -1) => void;
  onCollapse: () => void;
  onRename: (v: string) => void;
  onPhoto: (op: "primary" | "remove", fileId: string) => void;
  photoBusy: boolean;
  onAddPhoto: () => void;
  onPickLocation: () => void;
  sessionLocationLabel: string | null;
  containerLabel: string | null;
  onConfirm: () => void;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  const meta = (it.suggested_metadata ?? {}) as { extra_photos?: string[] };
  const extras = Array.isArray(meta.extra_photos) ? meta.extra_photos : [];
  const fileUrl = (id: string) => `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw?variant=thumb`;
  // Same rule as the thumbnail above — these two used to disagree with each
  // other (the cover never consulted catalog_image_file_id at all).
  const cover = useImageSrc(
    leadPhoto(it, {
      catalog: [it.catalog_image_file_id ? fileUrl(it.catalog_image_file_id) : null, it.catalog_image_url ?? null],
      yours: it.image_file_id ? fileUrl(it.image_file_id) : null,
    }).src,
  );
  const dest = it.suggested_candidates?.[0]?.label ?? null;
  const where = containerLabel ?? it.scan_area ?? sessionLocationLabel;

  return (
    // The sheet may use the whole viewport above the shutter and its contents
    // must FIT — the max-h + overflow is a backstop for short phones, not a
    // design surface (the mock: content that stops fitting means cut content).
    <div data-testid="capture-sheet" className="max-h-[calc(100dvh-15rem)] overflow-y-auto">
      <button
        type="button"
        onClick={onCollapse}
        data-testid="capture-sheet-collapse"
        aria-label="Close"
        className="w-full flex flex-col items-center gap-1 pt-2 pb-1 text-white/40 hover:text-white/80"
      >
        <span className="h-1 w-9 rounded-full bg-white/35" />
        <ChevronDown size={16} />
      </button>

      <div className="px-3">
        <div className="w-full h-[124px] rounded-xl border border-white/15 bg-white/5 overflow-hidden grid place-items-center">
          {cover ? (
            <img src={cover} alt={name ?? "capture"} className="w-full h-full object-cover" />
          ) : (
            <Camera size={26} className="text-white/30" />
          )}
        </div>
        {/* Gallery: cover first, then the extras. Tap one to make it the cover;
            ✕ removes it. */}
        <div className="flex items-center gap-1.5 mt-2">
          {it.image_file_id && <GalleryTile slug={slug} fileId={it.image_file_id} primary />}
          {extras.map((f) => (
            <GalleryTile
              key={f}
              slug={slug}
              fileId={f}
              onMakeCover={() => onPhoto("primary", f)}
              onRemove={() => onPhoto("remove", f)}
              busy={photoBusy}
            />
          ))}
          <button
            type="button"
            onClick={onAddPhoto}
            data-testid="capture-sheet-addphoto"
            className="w-11 h-11 rounded-lg border border-dashed border-white/30 text-white/50 grid place-items-center shrink-0"
            aria-label="Add another photo"
          >
            <Plus size={16} />
          </button>
          {extras.length > 0 && (
            <span className="text-[10.5px] text-white/40 leading-tight ml-0.5">tap a shot<br />to make it the cover</span>
          )}
        </div>
      </div>

      <label className="block px-3 mt-2.5">
        <span className="block text-[9.5px] font-mono uppercase tracking-widest text-white/40 mb-1">What is it</span>
        <input
          defaultValue={name ?? ""}
          // Keyed by the ITEM only. Keying on the name too meant every
          // background poll that filled in an identity remounted the field
          // mid-edit and ate what you were typing.
          key={it.id}
          placeholder="name it"
          data-testid="capture-sheet-name"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== name) onRename(v); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          className="w-full rounded-lg border border-white/20 bg-white/10 px-2.5 py-2 text-white text-[13.5px] focus:outline-none focus:border-cobble-400"
        />
      </label>

      <div className="flex items-end gap-3 px-3 mt-2.5">
        <div>
          <span className="block text-[9.5px] font-mono uppercase tracking-widest text-white/40 mb-1">Quantity</span>
          <QtyStepper value={shownQty} onBump={bump} big />
        </div>
        <div className="flex-1 min-w-0">
          <span className="block text-[9.5px] font-mono uppercase tracking-widest text-white/40 mb-1">Location</span>
          <button
            type="button"
            onClick={onPickLocation}
            disabled={!!containerLabel}
            data-testid="capture-sheet-location"
            className="w-full inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 py-2 text-white text-[13px] disabled:opacity-70"
          >
            <MapPin size={12} className="shrink-0 text-cobble-300" />
            <span className="truncate">{where ?? "not set"}</span>
          </button>
        </div>
      </div>
      {/* An armed container bin isn't a location — say so instead of offering a
          picker that would write the wrong field. */}
      <div className="px-3 mt-1 text-[10.5px] text-white/40">
        {containerLabel
          ? `going into ${containerLabel} - clear the bin to choose a location`
          : dest
            ? `looks like ${dest} - route it from the inbox`
            : "from where you're standing - tap to override just this one"}
      </div>

      <div className="flex items-center gap-2 px-3 mt-2.5 pb-1">
        <button
          type="button"
          onClick={onDelete}
          disabled={deleteBusy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 text-white/80 text-[13px] px-3 py-2 disabled:opacity-50"
        >
          <Trash2 size={13} /> Delete
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onConfirm}
          data-testid="capture-sheet-confirm"
          className="inline-flex items-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-[13px] font-semibold px-4 py-2"
        >
          <Check size={13} /> Looks right
        </button>
      </div>
    </div>
  );
}

function GalleryTile({
  slug, fileId, primary, onMakeCover, onRemove, busy,
}: {
  slug: string;
  fileId: string;
  primary?: boolean;
  onMakeCover?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const src = useImageSrc(`/api/v1/orgs/${slug}/modules/core-files/files/${fileId}/raw?variant=thumb`);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={primary || busy}
        onClick={onMakeCover}
        aria-label={primary ? "Cover photo" : "Make this the cover"}
        className={
          "w-11 h-11 rounded-lg overflow-hidden border bg-white/5 " +
          (primary ? "border-cobble-400 ring-1 ring-cobble-400" : "border-white/20")
        }
      >
        {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : null}
      </button>
      {!primary && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label="Remove this photo"
          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/80 border border-white/25 text-white/80 grid place-items-center"
        >
          <X size={9} />
        </button>
      )}
    </div>
  );
}

/** The capture surface's SHELL — the rounded panel that sits above the shutter.
 *  Exported so the barcode result renders in the same place, shape AND surface
 *  as a photo capture: one surface, whatever you pointed the camera at (the author,
 *  2026-08-03: "aren't you making it always be JUST a drawer?").
 *
 *  It is deliberately not the Modal primitive. A centred dialog over a live
 *  viewfinder hides what you're aiming at, and the standing rule is that
 *  nothing covers the shutter row.
 *
 *  Surface: the drawer's dark sheet, at every app theme. The content inside
 *  (ScanResultModal + TrackedMatchBanner) is written in semantic tokens with
 *  `dark:` variants — `dark force-dark` flips both halves of that system for
 *  this subtree only, so a light-theme session gets the same legible dark
 *  sheet without restyling a single child (see index.css .force-dark).
 *
 *  Height: the whole viewport above the shutter is available, and content is
 *  meant to FIT — the max-h + overflow is a short-phone backstop, not a design
 *  surface (the author: no scroll / cut-off elements inside the sheet). */
export function CaptureSheetShell({
  title,
  onClose,
  children,
}: {
  title?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const swipe = useSheetSwipe(undefined, onClose);
  const slide = useAnimatedHeight<HTMLDivElement>();
  return (
    <div
      data-testid="capture-shell"
      {...swipe}
      // Same rule as the drawer: the sheet grows into a result (the name
      // arriving, a tracked-match banner appearing) instead of jumping.
      style={slide.style}
      className="dark force-dark relative max-w-md mx-auto rounded-2xl border border-white/15 bg-[#0b1119]/95 backdrop-blur-md shadow-2xl overflow-hidden"
    >
      <div ref={slide.innerRef}>
      {/* No ✕. It did exactly what the grip, a swipe-down and "Save & next"
          already do — three controls, one action, and "what does the X
          actually do? does it save? or discard?" (the author) is the cost of the
          redundancy. The grip is the dismiss affordance; the button row below
          carries the labeled exits. */}
      {onClose && <Grip onTap={onClose} label="Dismiss, it stays in the inbox" />}
      {title && (
        <div className={"flex items-center gap-2 px-3 pb-1.5 " + (onClose ? "-mt-1" : "pt-3")}>
          <div className="text-content text-[13.5px] font-semibold flex-1">{title}</div>
        </div>
      )}
      <div className="px-3 pb-3 max-h-[calc(100dvh-15rem)] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
