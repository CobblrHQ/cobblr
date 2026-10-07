// THE frame an entity's photo sits in: a tile on a wall, a card, a list
// thumbnail, a cover on a shelf, a pick in a picker. One component, so a photo
// can never decide the size of the thing it is shown in.
//
// It could, and did. The vending wall asked for a 4:3 box and put an <img> at
// height 100% inside it; an aspect-ratio box keeps `min-height: auto`, so a
// tall photo (a bag of celery) still pushed its natural height through and
// its row grew to ~800px beside a short tile for eggs. Each surface drew its
// own <img>, and each found its own version of that. Here the box has its
// size before the picture arrives (an aspect ratio, a fixed square, or its
// parent's box) and the picture is laid out ABSOLUTELY inside it, so it can
// only fill the box, never stretch it.
//
// - fit: "cover" (the default) fills the box and crops; "contain" shows the
//   whole picture, for a label or a cover where the text is the point.
// - A missing or broken photo keeps the same box: a swatch when the item's
//   identity is a colour, else the name's initial.
// - Loads lazily and decodes off the main thread; the box is reserved, so
//   nothing moves when it arrives.
// - Internal file URLs need the bearer token; the frame resolves them
//   (useImageSrc), so a caller passes the stored path as it is.
//
// lint:entity-photo-frame refuses a raw <img> of a resolved entity photo
// anywhere else.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { reloadPicture, useImageSrc } from "./useImageSrc";
import { reportBrokenPicture } from "./brokenPictures";
import { pickThumb, type SwatchFieldDef } from "./swatch";
import { entityInitial } from "./entity-initial";

export type PhotoAspect = "square" | "4/3" | "3/4" | "2/3" | "16/9";

const ASPECT: Record<PhotoAspect, string> = {
  square: "1 / 1",
  "4/3": "4 / 3",
  "3/4": "3 / 4",
  "2/3": "2 / 3",
  "16/9": "16 / 9",
};

export interface EntityPhotoProps {
  /** The stored path or URL (image_path, a file URL). Null shows the placeholder. */
  src?: string | null;
  /** Alt text, and the initial the placeholder shows. */
  alt: string;
  /** The box, decided before the picture: an aspect ratio at the width the
   *  layout gives it, a fixed square in px, or "fill" to take the parent's
   *  box (the parent must be positioned and sized). */
  aspect?: PhotoAspect;
  size?: number;
  fill?: boolean;
  /** "cover" crops to fill; "contain" shows the whole picture. */
  fit?: "cover" | "contain";
  /** Classes for the box (rounding, border, ring, background). */
  className?: string;
  /** Classes for the picture itself (a dimmed sold-out tile). */
  imgClassName?: string;
  /** What shows with no photo, in place of the initial; null for an empty
   *  box. Same box either way. */
  placeholder?: ReactNode;
  /** Swatch preference, as EntityThumb and EntityTile had it: a colour field
   *  holding a hex wins over the photo; `color` is a fallback only. */
  color?: string | null;
  values?: Record<string, unknown> | null;
  fieldDefs?: readonly SwatchFieldDef[] | null;
  /** Load now rather than when scrolled near (a detail header, a lightbox). */
  eager?: boolean;
  /** Overlays laid over the photo: a badge, a status dot, a count. */
  children?: ReactNode;
  title?: string;
  /** Told when the picture fails to load, after the frame has fallen back to
   *  its placeholder: a caller with a second source tries it. */
  onBroken?: () => void;
  "data-testid"?: string;
}

export function EntityPhoto({
  src,
  alt,
  aspect,
  size,
  fill,
  fit = "cover",
  className = "",
  imgClassName = "",
  placeholder,
  color,
  values,
  fieldDefs,
  eager,
  children,
  title,
  onBroken,
  "data-testid": testId,
}: EntityPhotoProps) {
  const choice = pickThumb({ hasImage: !!src, values, defs: fieldDefs, color });
  const wantSwatch = choice.kind === "swatch";
  const resolved = useImageSrc(wantSwatch ? null : src);
  // A broken path degrades to the placeholder, never the browser's broken-image icon.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [resolved]);
  const retried = useRef(false);
  useEffect(() => {
    retried.current = false;
  }, [src]);
  const box: CSSProperties = fill
    ? { position: "absolute", inset: 0 }
    : size
      ? { width: size, height: size, flexShrink: 0 }
      : { width: "100%", aspectRatio: ASPECT[aspect ?? "square"] };
  const swatch = wantSwatch ? choice.hex : !resolved || failed ? (choice.kind === "fallback" ? choice.hex : null) : null;
  const showImg = !!resolved && !failed && !wantSwatch;
  const initialSize = size ? (size >= 64 ? "text-lg" : size >= 40 ? "text-sm" : "text-[10px]") : "text-3xl";
  return (
    <div
      data-entity-photo={showImg ? "photo" : swatch ? "swatch" : "placeholder"}
      data-testid={testId}
      title={title}
      style={{ ...box, ...(swatch ? { background: swatch } : null) }}
      className={`relative overflow-hidden ${swatch ? "ring-1 ring-black/10 dark:ring-white/15" : "bg-subtle"} ${className}`}
    >
      {showImg ? (
        <img
          src={resolved}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={(e) => {
            // "Loaded" with nothing to draw: a body cut short can decode to
            // an empty picture without an error. Treated as one.
            if (e.currentTarget.naturalWidth === 0) e.currentTarget.dispatchEvent(new Event("error"));
          }}
          onError={() => {
            setFailed(true);
            // Once more past the browser's cache: a kept copy cut short draws
            // nothing however often it is revalidated.
            if (src && !retried.current) {
              retried.current = true;
              if (reloadPicture(src)) return;
            }
            if (src) reportBrokenPicture(src, "the picture would not draw");
            onBroken?.();
          }}
          className={`absolute inset-0 h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"} ${imgClassName}`}
        />
      ) : (
        <span
          aria-label={swatch ? alt : undefined}
          className={`absolute inset-0 flex items-center justify-center font-mono ${swatch ? "text-black/25 dark:text-black/30" : "text-faint"} ${initialSize}`}
        >
          {placeholder !== undefined ? placeholder : entityInitial(alt)}
        </span>
      )}
      {children}
    </div>
  );
}
