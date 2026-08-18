// ImageLightbox — THE full-screen image viewer for the whole app. One shape
// everywhere an image gets enlarged: the scan inbox (catalog / your photo / web
// candidates) and any entity's Files gallery. Big image on a dark backdrop, a
// thumbnail filmstrip under it to flip between the related shots, a caption, and
// an optional primary action ("Use this image") for the picker context. Click
// the image to pixel-peep (natural size, scrollable) so a plate / VIN / label
// reads; Escape, a backdrop click, or Close dismisses; ← / → page.
//
// Before this there were three lookalikes — the scan catalog zoom, the image
// search "view full size", and a one-off attachment lightbox — each drifting.
// This is the single one they all now use (reported 2026-07-24).
//
// Sources are either an authed core-files reference ({ slug, fileId }, routed
// through useImageSrc for the Bearer token) or a plain url (an already-resolved
// blob, or an external candidate). Each thumbnail and the main image resolve
// their own src through <Frame>, so a filmstrip of authed files is fine.

import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useImageSrc, OverlayFlag } from "@cobblr/platform-web";
import { api } from "../lib/api";

export interface LightboxItem {
  key: string;
  /** Shown under the image. */
  caption?: string;
  /** Optional external link — the caption becomes a link to it. */
  href?: string;
  /** Authed core-files source (preferred for attachments). */
  file?: { slug: string; fileId: string };
  /** Plain full-size url (an already-resolved blob, or an external candidate). */
  url?: string;
  /** Plain thumbnail url; defaults to `url`. */
  thumbUrl?: string;
  /** Draw a divider immediately before this thumbnail.
   *
   *  The strip mixes two kinds of thing: images that are already YOURS (the
   *  photo you took, the catalog image on the record) and live web search
   *  results. Running them together makes the one image you can identify at a
   *  glance just another tile to hunt for. The caller says where the seam is;
   *  this component does not know what the groups mean. */
  dividerBefore?: boolean;
}

type Variant = "thumb" | "medium" | "original";

/** Resolve one item's src for a given size. Authed files route through
 *  useImageSrc; plain urls pass straight through. Always calls the hook (rules
 *  of hooks) — the file url is "" for a plain-url item, which useImageSrc
 *  treats as nothing. */
function useItemSrc(item: LightboxItem, variant: Variant, fellBack = false): string | null {
  const fileUrl = item.file ? api.fileRawUrl(item.file.slug, item.file.fileId, variant) : "";
  const authed = useImageSrc(fileUrl);
  if (item.file) return authed;
  if (variant === "thumb") return item.thumbUrl ?? item.url ?? null;
  // The full-size original failed to load. The thumbnail is the picture the
  // strip is already showing, so it demonstrably works — a smaller image beats
  // an empty viewer for a photo the user can see two inches away (2026-08-14).
  if (fellBack) return item.thumbUrl ?? null;
  return item.url ?? null;
}

/** A single resolved <img> (main image or a filmstrip thumb). */
function Frame({
  item,
  variant,
  className,
  onClick,
  onError,
  draggable,
}: {
  item: LightboxItem;
  variant: Variant;
  className: string;
  onClick?: (e: React.MouseEvent) => void;
  onError?: () => void;
  draggable?: boolean;
}) {
  const [fellBack, setFellBack] = useState(false);
  useEffect(() => setFellBack(false), [item.url, item.thumbUrl]);
  const src = useItemSrc(item, variant, fellBack);
  if (!src) {
    return (
      <div className={className + " flex items-center justify-center text-white/40 text-[10px]"}>…</div>
    );
  }
  return (
    <img
      src={src}
      alt={item.caption ?? ""}
      className={className}
      onClick={onClick}
      onError={() => {
        // One retry at the smaller size before telling anyone it failed.
        if (!fellBack && !item.file && item.thumbUrl && item.thumbUrl !== item.url) {
          setFellBack(true);
          return;
        }
        onError?.();
      }}
      draggable={draggable}
      loading="lazy"
    />
  );
}

export function ImageLightbox({
  items,
  index,
  onIndex,
  onClose,
  searchSlot,
  action,
  onItemError,
}: {
  items: LightboxItem[];
  /** Index into `items` of the image on screen. */
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Rendered at the top of the footer. For a picker that should let you refine
   *  the search WITHOUT leaving the viewer: you are comparing candidates here,
   *  so the control that changes which candidates exist belongs here too.
   *
   *  It works because the footer band swallows clicks; in a region where empty
   *  space dismissed, a text input would be unusable. */
  searchSlot?: React.ReactNode;
  /** Optional primary action (e.g. "Use this image" in the search picker).
   *  `label` may be a function of the current item — return null to hide the
   *  button for that item (e.g. no "Use this image" on the item's own photos). */
  action?: {
    label: string | ((item: LightboxItem) => string | null);
    busy?: boolean;
    onAction: (item: LightboxItem) => void;
  };
  /** Called when an item's full-size fails to load (caller can drop it). */
  onItemError?: (item: LightboxItem) => void;
}) {
  const many = items.length > 1;
  const current = items[index];
  // Pixel-peep: fit-to-screen by default, natural size (scrollable) when zoomed.
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [index]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && many) onIndex((index - 1 + items.length) % items.length);
      else if (e.key === "ArrowRight" && many) onIndex((index + 1) % items.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, many, onIndex, onClose]);

  if (!current) return null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${index + 1} of ${items.length}`}
    >
      <OverlayFlag />
      <button
        onClick={onClose}
        className="absolute z-10 top-3 right-3 p-2 rounded-full bg-black/50 text-white/90 hover:bg-black/70 hover:text-white transition"
        title="Close (Esc)"
        aria-label="Close"
      >
        <X size={20} />
      </button>

      {/* Main image. Fit-to-screen, or natural-size + scroll when zoomed. */}
      <div
        className={
          "flex-1 min-h-0 flex items-center justify-center " +
          (zoomed ? "overflow-auto p-4" : "p-4 sm:p-6")
        }
      >
        <Frame
          item={current}
          variant={zoomed ? "original" : "medium"}
          draggable={false}
          onClick={(e) => {
            stop(e);
            setZoomed((z) => !z);
          }}
          onError={() => onItemError?.(current)}
          className={
            zoomed
              ? "max-w-none cursor-zoom-out rounded"
              : "max-w-full max-h-full object-contain rounded shadow-2xl cursor-zoom-in"
          }
        />
      </div>

      {/* Footer: caption + action + filmstrip. stopPropagation so using the
          controls doesn't dismiss the viewer. */}
      <div className="shrink-0 w-full max-w-3xl mx-auto p-4 space-y-2" onClick={stop}>
        {searchSlot}
        <div className="flex items-center justify-between gap-3">
          {current.caption ? (
            current.href ? (
              <a
                href={current.href}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-white/60 hover:text-white truncate"
              >
                {current.caption}
              </a>
            ) : (
              <span className="text-[11px] text-white/60 truncate">{current.caption}</span>
            )
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2 shrink-0">
            {many && <span className="text-[11px] text-white/40">{index + 1} / {items.length}</span>}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm text-white/80 hover:bg-white/10"
            >
              Close
            </button>
            {action &&
              (() => {
                const label = typeof action.label === "function" ? action.label(current) : action.label;
                if (!label) return null;
                return (
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() => action.onAction(current)}
                    className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 px-3 py-1.5 text-sm font-medium text-white"
                  >
                    {action.busy ? "Saving…" : label}
                  </button>
                );
              })()}
          </div>
        </div>

        {/* Flip through the other images without leaving.

            CONTAIN, not cover. These thumbnails exist to be COMPARED — you are
            choosing which of fourteen search results is the right picture of the
            thing. A square crop of a product shot keeps the middle band and
            throws away the lid and the base, so a tall jar becomes an anonymous
            stripe of label and every candidate looks alike ("mostly cropped and
            impossible to tell that that was indeed the perfect image", reported
            2026-08-15). Letterboxing wastes a little of a 64px tile; cropping
            wastes the whole point of the strip. */}
        {many && (
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
            {items.map((it, i) => (
              <Fragment key={it.key}>
                {it.dividerBefore && i > 0 && (
                  <div
                    aria-hidden
                    className="w-px self-stretch shrink-0 bg-white/20 mx-1.5"
                  />
                )}
              <button
                type="button"
                onClick={() => onIndex(i)}
                title={it.caption ?? ""}
                className={
                  "w-16 h-16 shrink-0 rounded overflow-hidden bg-white/5 transition border-2 " +
                  (i === index ? "border-cobble-400" : "border-transparent hover:border-white/40")
                }
              >
                <Frame item={it} variant="thumb" className="w-full h-full object-contain" />
              </button>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
