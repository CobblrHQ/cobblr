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

import { EntityPhoto } from "./EntityPhoto";
import type { SwatchFieldDef } from "./swatch";

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
  // The frame decides everything a thumbnail is: the fixed square, the swatch
  // that wins over a photo, the initial when there is none, the broken-image
  // fallback. A thumbnail is one size of it.
  return (
    <EntityPhoto
      src={src}
      alt={alt}
      size={size}
      color={color}
      values={values}
      fieldDefs={fieldDefs}
      className={"rounded" + (className ? ` ${className}` : "")}
    />
  );
}
