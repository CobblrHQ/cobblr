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

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, ChevronDown, Loader2, MapPin, Minus, Plus, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { useImageSrc } from "@cobblr/platform-web";
import { api, type ScanInboxItem } from "../lib/api";

/** How long a photo item may sit un-named before we stop saying "identifying…"
 *  (mirrors the inbox's own stale rule). */
const IDENTIFY_WINDOW_MS = 60_000;

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
  confirmBusy,
  onDismiss,
  onAddPhoto,
  onRetake,
  armed,
  onCancelArm,
  onPickLocation,
  sessionLocationLabel,
  containerLabel,
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
  confirmBusy: boolean;
  /** Hide WITHOUT filing — the item stays pending in the inbox. */
  onDismiss: () => void;
  /** Arm the shutter to APPEND its next frame to this item (label shot, then
   *  the display shot, on one record). */
  onAddPhoto: (item: ScanInboxItem) => void;
  /** Arm the shutter to REPLACE this item's photo and read it again. */
  onRetake: (item: ScanInboxItem) => void;
  /** Which arm is live, so the drawer can say so and offer a way out. */
  armed: "append" | "retake" | null;
  onCancelArm: () => void;
  /** Open the per-item location override (its own layer — a full picker can't
   *  fit inside a sheet that isn't allowed to scroll). */
  onPickLocation: (item: ScanInboxItem) => void;
  /** The session's stamp, shown as what an un-overridden item inherits. */
  sessionLocationLabel: string | null;
  /** A container bin is armed → the item files INTO it, not into a location. */
  containerLabel: string | null;
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
  const [expanded, setExpanded] = useState(false);
  const [qty, setQty] = useState<number | null>(null);
  const qtyTimer = useRef<number | null>(null);
  useEffect(() => {
    setQty(null);
    setExpanded(false); // a new capture always starts closed — never interrupt the burst
    if (qtyTimer.current) window.clearTimeout(qtyTimer.current);
  }, [item?.id]);
  const saveQty = useMutation({
    mutationFn: (quantity: number) => api.updateScanItem(slug, item!.id, { quantity }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] }),
  });
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
  const shownQty = qty ?? (it && it.quantity > 0 ? it.quantity : 1);
  const bump = (d: 1 | -1) => {
    if (!item) return;
    const next = Math.max(1, shownQty + d);
    setQty(next);
    if (qtyTimer.current) window.clearTimeout(qtyTimer.current);
    qtyTimer.current = window.setTimeout(() => saveQty.mutate(next), 500);
  };

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
  const dest = it!.suggested_candidates?.[0]?.label ?? it!.scan_area ?? null;
  // Local frame beats everything for a PHOTO item (never swap away from the
  // user's own shot); a barcode item may show its catalog image.
  const thumbUrl =
    localFrameItemId === it!.id && localFrameUrl
      ? localFrameUrl
      : !isPhoto && it!.catalog_image_url
        ? it!.catalog_image_url
        : null;

  return (
    <div
      data-testid="capture-drawer"
      className="relative max-w-md mx-auto rounded-2xl border border-white/15 bg-black/70 backdrop-blur-md overflow-hidden"
    >
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
          confirmBusy={confirmBusy}
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
      {/* TWO rows on purpose. Everything on one line left the name ~48px at
          phone width ("Ca…"): thumb + stepper + Confirm + the ✕ gutter eat
          310 of 374. The identity gets a full-width line; the controls get
          their own, with Confirm still in the right-thumb corner. */}
      {/* Tap the identity row (or the grip) to open the sheet. The stepper and
          the footer buttons stopPropagation so they never expand by accident. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => { if (e.key === "Enter") setExpanded(true); }}
        className="flex items-start gap-2.5 px-3 pt-2.5 pr-8 cursor-pointer"
      >
        <Thumb url={thumbUrl} name={name ?? "item"} />
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="text-white text-[13.5px] font-semibold leading-tight line-clamp-2">
            {name ?? (identifying ? "Photo saved" : "Captured item")}
          </div>
          <div className="text-white/60 text-[11px] truncate mt-0.5">
            {armed ? (
              <span className="text-cobble-300 font-medium">
                {armed === "append" ? "next shot joins this one" : "next shot replaces the photo"}
              </span>
            ) : identifying ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={10} className="animate-spin" /> identifying…
              </span>
            ) : dest ? (
              <>→ {dest}</>
            ) : (
              "in your scan inbox"
            )}
          </div>
        </div>
      </div>
      {armed ? (
        <div className="flex items-center gap-2 px-3 pt-2 pb-2.5">
          <span className="text-[11px] text-cobble-300 flex-1 min-w-0">
            barcode reading is paused - press the shutter
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
        {/* − N + : the ScanResultModal stepper's shape, thumb-sized. */}
        <div className="flex items-center rounded-lg border border-white/25 bg-white/10 overflow-hidden shrink-0">
          <button type="button" onClick={() => bump(-1)} aria-label="Fewer" className="px-3 py-1.5 text-white disabled:opacity-40" disabled={shownQty <= 1}>
            <Minus size={13} />
          </button>
          <span data-testid="capture-drawer-qty" className="min-w-[1.7rem] text-center text-white text-[13px] font-bold">
            {shownQty}
          </span>
          <button type="button" onClick={() => bump(1)} aria-label="More" className="px-3 py-1.5 text-white">
            <Plus size={13} />
          </button>
        </div>
        <div className="flex-1" />
        {/* The right slot is where the thumb lands, so it belongs to the action
            you take every time. CONFIRM is the platform's verb for filing an
            inbox item (api.confirmScanItem) — deliberately NOT "Done", because
            the shutter row's ✓ Done (which exits to the inbox) sits ~40px
            below this and two Dones that deep in muscle memory is a mis-tap. */}
        <button
          type="button"
          disabled={confirmBusy}
          onClick={() => onConfirm(it!)}
          data-testid="capture-drawer-confirm"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-[13px] font-semibold px-4 py-2 shrink-0 disabled:opacity-50"
        >
          {confirmBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirm
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
  );
}

function Thumb({ url, name }: { url: string | null; name: string }) {
  return (
    <div className="w-[52px] h-[52px] rounded-lg border border-white/20 bg-white/5 overflow-hidden grid place-items-center shrink-0">
      {url ? (
        <img src={url} alt={name} className="w-full h-full object-cover" />
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
  onConfirm, confirmBusy, onDelete, deleteBusy,
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
  confirmBusy: boolean;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  const meta = (it.suggested_metadata ?? {}) as { extra_photos?: string[] };
  const extras = Array.isArray(meta.extra_photos) ? meta.extra_photos : [];
  const fileUrl = (id: string) => `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw?variant=thumb`;
  const cover = useImageSrc(it.image_file_id ? fileUrl(it.image_file_id) : it.catalog_image_url ?? null);
  const dest = it.suggested_candidates?.[0]?.label ?? null;
  const where = containerLabel ?? it.scan_area ?? sessionLocationLabel;

  return (
    <div data-testid="capture-sheet">
      <button
        type="button"
        onClick={onCollapse}
        data-testid="capture-sheet-collapse"
        aria-label="Close"
        className="w-full flex justify-center py-2 text-white/40 hover:text-white/80"
      >
        <ChevronDown size={18} />
      </button>

      <div className="px-3">
        <div className="w-full h-[150px] rounded-xl border border-white/15 bg-white/5 overflow-hidden grid place-items-center">
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

      <label className="block px-3 mt-3">
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

      <div className="flex items-end gap-3 px-3 mt-3">
        <div>
          <span className="block text-[9.5px] font-mono uppercase tracking-widest text-white/40 mb-1">Quantity</span>
          <div className="flex items-center rounded-lg border border-white/25 bg-white/10 overflow-hidden">
            <button type="button" onClick={() => bump(-1)} aria-label="Fewer" disabled={shownQty <= 1} className="px-3 py-2 text-white disabled:opacity-40"><Minus size={13} /></button>
            <span className="min-w-[1.8rem] text-center text-white text-[13px] font-bold">{shownQty}</span>
            <button type="button" onClick={() => bump(1)} aria-label="More" className="px-3 py-2 text-white"><Plus size={13} /></button>
          </div>
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
          ? `filing into ${containerLabel} - clear the bin to choose a location`
          : dest
            ? `files into ${dest}`
            : "from where you're standing - tap to override just this one"}
      </div>

      <div className="flex items-center gap-2 px-3 mt-3 pb-1">
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
          disabled={confirmBusy}
          data-testid="capture-sheet-confirm"
          className="inline-flex items-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-[13px] font-semibold px-4 py-2 disabled:opacity-50"
        >
          {confirmBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Confirm
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
