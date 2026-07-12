// Thumbnail for an entity's hero image. Shared across the web shell
// and module UIs (inventory PartsListPage, etc) so the look stays
// consistent.
//
// Source: every user-facing entity (inventory:part, machines:machine,
// assets:asset, projects:project) has an `image_path` column on its
// tenant table. CRUD endpoints accept image_path as a free-form URL
// — fully-qualified (picsum / unsplash / a CDN) or a relative path
// under /api/v1/orgs/:slug/modules/core-files/files/:id/raw (created
// via core-files uploads).
//
// External URLs render straight through <img src>. Internal file
// URLs need the Bearer JWT, which <img src> can't carry, so
// useImageSrc fetches them with Authorization, converts to a blob:
// URL, and revokes it on unmount.
//
// When image_path is absent we render a same-sized initial-letter
// chip so list rows stay aligned (no height jitter when some items
// have photos and others don't).
//
// Colour-swatch preference: some entities' identity IS a colour (a yarn's
// colourway), not a photo — a generic catalog "skein" shot buries it. When a
// caller passes the item's field `values` (+ optional `fieldDefs`) and one is a
// swatch-eligible colour field holding a hex, the swatch WINS over image_path.
// Callers that pass neither keep the photo-first behaviour. See swatch.ts.

import { useEffect, useState } from "react";
import { useImageSrc } from "./useImageSrc";
import { pickThumb, type SwatchFieldDef } from "./swatch";

interface Props {
  src?: string | null;
  /** Used for alt text + the initial-letter fallback. */
  alt: string;
  /** Square pixel size. */
  size: number;
  /** Extra classes (e.g. ring-1 ring-line on detail headers). */
  className?: string;
  /** Optional hex color (e.g. a yarn's `color` field). With no photo, the
   *  thumbnail becomes a swatch of this color instead of an initial-letter chip
   *  — gives the square an obvious purpose. Ignored if not a valid hex.
   *  Fallback-only: a photo still wins. To make the swatch win over the photo,
   *  pass `values` (+ `fieldDefs`) instead. */
  color?: string | null;
  /** The item's stored field VALUES (its metadata bag). Passing this opts the
   *  thumbnail into swatch-preference: a swatch-eligible colour field with a hex
   *  value renders as a swatch INSTEAD of image_path. */
  values?: Record<string, unknown> | null;
  /** The entity's field DEFS, paired with `values` to decide which field is a
   *  swatch-eligible colour field (honours help-based colour fields, ignores a
   *  stray `color` key that isn't a declared colour field). Optional — without
   *  defs the conventional `color`/`colour` keys are recognised by name. */
  fieldDefs?: readonly SwatchFieldDef[] | null;
}

export function EntityThumb({ src, alt, size, className, color, values, fieldDefs }: Props) {
  // Decided before any fetch: a preferred swatch short-circuits the photo, so
  // don't even resolve the (auth-fetched) image when the swatch wins.
  const choice = pickThumb({ hasImage: !!src, values, defs: fieldDefs, color });
  const wantSwatch = choice.kind === "swatch";
  const resolved = useImageSrc(wantSwatch ? null : src);
  // A broken/404 image_path must degrade to the initial-letter chip, not the
  // browser's broken-image icon. (useImageSrc only nulls out the bearer-fetch
  // path on failure; a direct <img src> needs onError.)
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [resolved]);
  const s = { width: size, height: size } as const;
  const base = "rounded shrink-0 object-cover";

  // Swatch wins over the photo (colour-identity item, e.g. yarn colourway).
  if (wantSwatch) {
    return (
      <div
        style={{ ...s, backgroundColor: choice.hex }}
        title={alt}
        aria-label={alt}
        className={`${base} ring-1 ring-black/10 dark:ring-white/15` + (className ? ` ${className}` : "")}
      />
    );
  }

  if (!resolved || failed) {
    // Color swatch fallback (e.g. yarn with no photo): show the colour itself.
    const hex = choice.kind === "fallback" ? choice.hex : null;
    if (hex) {
      return (
        <div
          style={{ ...s, backgroundColor: hex }}
          title={alt}
          aria-label={alt}
          className={`${base} ring-1 ring-black/10 dark:ring-white/15` + (className ? ` ${className}` : "")}
        />
      );
    }
    const initial = alt.trim().slice(0, 1).toUpperCase() || "?";
    return (
      <div
        style={s}
        className={
          `${base} bg-subtle dark:bg-slate-800 text-faint dark:text-slate-500 flex items-center justify-center font-mono ` +
          (size >= 64 ? "text-lg" : size >= 40 ? "text-sm" : "text-[10px]") +
          (className ? ` ${className}` : "")
        }
      >
        {initial}
      </div>
    );
  }
  return (
    <img
      src={resolved}
      alt={alt}
      style={s}
      className={base + (className ? ` ${className}` : "")}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
