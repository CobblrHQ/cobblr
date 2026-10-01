// Lightbox: THE full-screen image viewer, for every place an image is looked
// at bigger. A report's screenshots, a record's photos, the scan inbox, a
// Files gallery, a print's camera frame: one viewer, so stepping through a set
// works the same everywhere (#4319). lint:image-viewers-use-the-lightbox fails
// a new viewer built any other way.
//
// Stepping: ← and → (not while typing in its own search box), the previous
// and next buttons at the sides, a swipe on a phone, or the filmstrip. It
// says where you are, "2 of 5". Esc closes it when it is the top layer, and
// as a modal OverlayLayer it holds the keyboard and gives focus back to the
// thumbnail that opened it (useDialogFocus, #4153). Click the picture to see
// it at its own size, scrollable, so a label or a serial reads.
//
// It takes URLs, one per size. An /api/v1/ URL is fetched with the session
// (useImageSrc), so an item from a signed-in file store and a plain web image
// look the same to it; the caller decides what the picture is.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OverlayLayer } from "./fixed-layers";
import { isTopLayer } from "./layer-stack";
import { OverlayCloseButton } from "./OverlayCloseButton";
import { type PastedImage } from "./pastedImage";
import { usePasteImage } from "./usePasteImage";
import { useImageSrc } from "./useImageSrc";
import { useEscapeToClose } from "./useEscapeToClose";
import { isShortcut, typingIn } from "./shortcuts";

export interface LightboxItem {
  key: string;
  /** Shown under the image, and read out as its name. */
  caption?: string;
  /** Makes the caption a link out. */
  href?: string;
  /** The picture on screen. */
  src: string | null;
  /** Its natural-size original, for a closer look; defaults to `src`. */
  original?: string | null;
  /** The filmstrip's tile; defaults to `src`. */
  thumb?: string | null;
  /** Draw a divider before this tile: the caller's seam between two kinds of
   *  picture in one strip (the ones already yours, and web search results). */
  dividerBefore?: boolean;
}

export interface LightboxVerb {
  /** A function of the item on screen; null hides it for that item. */
  label: string | ((item: LightboxItem) => string | null);
  busy?: boolean;
  onAction: (item: LightboxItem) => void;
}

export interface LightboxProps {
  items: LightboxItem[];
  /** The index of the picture on screen. */
  index: number;
  /** Required to step; a single picture can leave it out. */
  onIndex?: (i: number) => void;
  onClose: () => void;
  /** Above the footer: a search that changes which pictures are in the set,
   *  for a picker comparing candidates without leaving the viewer. */
  searchSlot?: ReactNode;
  /** The primary verb ("Use this image"). */
  action?: LightboxVerb;
  /** Secondary verbs on the picture being looked at (rotate, crop, change). */
  tools?: LightboxVerb[];
  /** A picture's full size failed to load (the caller can drop it). */
  onItemError?: (item: LightboxItem) => void;
  /** Cmd+V while it is open: the caller decides what the pasted picture is for. */
  onPasteImage?: (pasted: PastedImage) => void;
}

const SWIPE_PX = 48;

function Picture({
  src,
  fallback,
  alt,
  className,
  onClick,
  onError,
}: {
  src: string | null;
  fallback?: string | null;
  alt: string;
  className: string;
  onClick?: (e: React.MouseEvent) => void;
  onError?: () => void;
}) {
  const [fellBack, setFellBack] = useState(false);
  useEffect(() => setFellBack(false), [src]);
  const resolved = useImageSrc(fellBack ? fallback : src);
  if (!resolved) {
    return <div className={className + " flex items-center justify-center text-white/40 text-[10px]"}>…</div>;
  }
  // photo-frame: the lightbox shows the whole picture at its own shape; it is a viewer, not a tile
  return (
    <img
      src={resolved}
      alt={alt}
      className={className}
      onClick={onClick}
      draggable={false}
      loading="lazy"
      onError={() => {
        // The smaller picture the strip already shows beats an empty viewer.
        if (!fellBack && fallback && fallback !== src) {
          setFellBack(true);
          return;
        }
        onError?.();
      }}
    />
  );
}

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={back ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

export function Lightbox({ items, index, onIndex = () => {}, onClose, searchSlot, action, tools, onItemError, onPasteImage }: LightboxProps) {
  const many = items.length > 1;
  const current = items[index];
  const layer = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [index]);

  const step = (by: number) => onIndex((index + by + items.length) % items.length);

  useEscapeToClose(true, layer, onClose);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A dialog opened over the viewer (a confirm from one of its tools)
      // owns the keys while it is up.
      if (layer.current && !isTopLayer(layer.current)) return;
      if (!many || typingIn(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isShortcut(e, "previous")) {
        e.preventDefault();
        onIndex((index - 1 + items.length) % items.length);
      } else if (isShortcut(e, "next")) {
        e.preventDefault();
        onIndex((index + 1) % items.length);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, many, onIndex]);

  // Paste, through the one paste door: the viewer covers the screen, so it is
  // the layer on top and takes a paste anywhere on it. A paste that carries no
  // picture is left alone: the search box in the footer still gets its text.
  usePasteImage(layer, {
    enabled: !!onPasteImage,
    onFiles: ([file]) => file && onPasteImage?.({ kind: "file", file }),
    onUrl: (url) => onPasteImage?.({ kind: "url", url }),
  });

  // A swipe: a mostly-sideways drag of a finger on the picture. Zoomed in,
  // the finger scrolls the picture instead.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const t = e.changedTouches[0];
    if (!start || !t || !many || zoomed) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    step(dx < 0 ? 1 : -1);
  };

  if (!current) return null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const name = current.caption || `Picture ${index + 1}`;
  const where = many ? `${index + 1} of ${items.length}` : null;
  const labelOf = (v: LightboxVerb) => (typeof v.label === "function" ? v.label(current) : v.label);

  return createPortal(
    <OverlayLayer
      ref={layer}
      className="z-[130] bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={where ? `${name}, ${where}` : name}
    >
      <OverlayCloseButton onClose={onClose} />

      <div
        className={"relative flex-1 min-h-0 flex items-center justify-center " + (zoomed ? "overflow-auto p-4" : "p-4 sm:p-6")}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        data-testid="lightbox-stage"
      >
        <Picture
          src={zoomed ? current.original ?? current.src : current.src}
          fallback={current.thumb}
          alt={name}
          onClick={(e) => {
            stop(e);
            setZoomed((z) => !z);
          }}
          onError={() => onItemError?.(current)}
          className={zoomed ? "max-w-none cursor-zoom-out rounded" : "max-w-full max-h-full object-contain rounded shadow-2xl cursor-zoom-in"}
        />
        {many && !zoomed && (
          <>
            <button
              type="button"
              aria-label="Previous picture"
              title="Previous (←)"
              onClick={(e) => {
                stop(e);
                step(-1);
              }}
              className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white/90 hover:bg-black/70 hover:text-white"
            >
              <Chevron back />
            </button>
            <button
              type="button"
              aria-label="Next picture"
              title="Next (→)"
              onClick={(e) => {
                stop(e);
                step(1);
              }}
              className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white/90 hover:bg-black/70 hover:text-white"
            >
              <Chevron />
            </button>
          </>
        )}
      </div>

      <div
        className="shrink-0 w-full max-w-3xl mx-auto p-4 space-y-2"
        // Clear of the home-indicator strip, where a swipe up beats the tap.
        style={{ paddingBottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))" }}
        onClick={stop}
      >
        {searchSlot}
        <div className="flex items-center justify-between gap-3">
          {current.caption ? (
            current.href ? (
              <a href={current.href} target="_blank" rel="noreferrer" className="text-[11px] text-white/60 hover:text-white truncate">
                {current.caption}
              </a>
            ) : (
              <span className="text-[11px] text-white/60 truncate">{current.caption}</span>
            )
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2 shrink-0">
            {where && (
              <span className="text-[11px] text-white/60 tabular-nums" aria-live="polite" data-testid="lightbox-position">
                {where}
              </span>
            )}
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-white/80 hover:bg-white/10">
              Close
            </button>
            {tools?.map((t, i) => {
              const label = labelOf(t);
              if (!label) return null;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={t.busy}
                  onClick={() => t.onAction(current)}
                  className="rounded-md border border-white/20 px-3 py-1.5 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
                >
                  {t.busy ? "…" : label}
                </button>
              );
            })}
            {action &&
              (() => {
                const label = labelOf(action);
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

        {/* CONTAIN, not cover: the strip is for comparing, and a square crop
            of a tall product shot keeps only its middle band. */}
        {many && (
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
            {items.map((it, i) => (
              <Fragment key={it.key}>
                {it.dividerBefore && i > 0 && <div aria-hidden className="w-px self-stretch shrink-0 bg-white/20 mx-1.5" />}
                <button
                  type="button"
                  onClick={() => onIndex(i)}
                  title={it.caption ?? ""}
                  aria-label={`${it.caption || `Picture ${i + 1}`}, ${i + 1} of ${items.length}`}
                  aria-current={i === index ? "true" : undefined}
                  className={
                    "w-16 h-16 shrink-0 rounded overflow-hidden bg-white/5 transition border-2 " +
                    (i === index ? "border-cobble-400" : "border-transparent hover:border-white/40")
                  }
                >
                  <Picture src={it.thumb ?? it.src} alt="" className="w-full h-full object-contain" />
                </button>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </OverlayLayer>,
    document.body,
  );
}
