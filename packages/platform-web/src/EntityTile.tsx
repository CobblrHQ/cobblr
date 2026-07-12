// Tile / gallery card for an entity row. Companion to EntityThumb —
// where EntityThumb is a small inline image for list rows,
// EntityTile is the full-card rendering for gallery / tile view
// modes on list pages. Pages alternate between the two via a
// view-mode toggle.
//
// Layout: square image on top (or initial-letter chip when no
// image_path), then title, optional subtitle, optional right-edge
// chip (state / qty / status). Card is fully clickable when wrapped
// in a Link.

import type { ReactNode } from "react";
import { useImageSrc } from "./useImageSrc";
import { pickThumb, type SwatchFieldDef } from "./swatch";

interface Props {
  /** Image URL or null. Falls back to an initial-letter card. */
  src?: string | null;
  /** Title shown under the image. Used for alt-text and the
   *  initial-letter fallback. */
  title: string;
  /** Optional secondary line under the title (manufacturer / theme
   *  / family / etc). */
  subtitle?: string | null;
  /** Optional small chip shown in the bottom-right of the image —
   *  state, qty, status. Pass a string or a styled ReactNode. */
  badge?: ReactNode;
  /** Optional swatch color (hex). When there's no image, fill the square
   *  with this instead of the initial-letter card — e.g. a yarn/filament
   *  colour is the item's identity. Mirrors EntityThumb's `color`. */
  color?: string | null;
  /** The item's stored field VALUES (its metadata bag). Passing this opts the
   *  tile into swatch-preference: a swatch-eligible colour field with a hex
   *  value fills the square INSTEAD of the photo. Mirrors EntityThumb. */
  values?: Record<string, unknown> | null;
  /** Field DEFS, paired with `values` to decide swatch-eligibility. Optional —
   *  without defs the conventional `color`/`colour` keys are recognised. */
  fieldDefs?: readonly SwatchFieldDef[] | null;
  /** Optional ember-tinted border when the row wants attention
   *  (low-stock, blocked, expired). */
  attention?: boolean;
}

export function EntityTile({ src, title, subtitle, badge, color, values, fieldDefs, attention }: Props) {
  const borderCls = attention
    ? "border-ember-300 dark:border-ember-700"
    : "border-line dark:border-slate-700";
  // A swatch-eligible colour field with a hex WINS over the photo (yarn's
  // colourway is its identity, not a generic catalog shot). Decided before the
  // fetch — skip loading the image when the swatch wins.
  const choice = pickThumb({ hasImage: !!src, values, defs: fieldDefs, color });
  const wantSwatch = choice.kind === "swatch";
  // Internal /api/v1/files URLs need Bearer auth, so route them
  // through useImageSrc which blob-loads them. External URLs and
  // null both pass through unchanged.
  const resolved = useImageSrc(wantSwatch ? null : src);
  const swatchHexColor = wantSwatch ? choice.hex : color;
  return (
    <div
      className={`rounded-xl overflow-hidden border bg-surface dark:bg-slate-900 hover:border-accent dark:hover:border-cobble-600 transition flex flex-col h-full ${borderCls}`}
    >
      <div className="aspect-square relative bg-subtle dark:bg-slate-800">
        {resolved ? (
          <img
            src={resolved}
            alt={title}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : swatchHexColor ? (
          // A swatch colour — the colour IS the identity (yarn, filament,
          // paint), either because there's no photo or because the colourway
          // wins over a generic catalog shot. Fill the square; the initial sits
          // subtly on top so two same-colour items stay distinguishable.
          <div
            className="w-full h-full flex items-center justify-center text-3xl font-mono text-black/25 dark:text-black/30"
            style={{ backgroundColor: swatchHexColor }}
          >
            {title.trim().slice(0, 1).toUpperCase()}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-3xl font-mono text-faint dark:text-slate-600">
            {title.trim().slice(0, 1).toUpperCase() || "?"}
          </div>
        )}
        {badge && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-surface/85 dark:bg-slate-900/85 backdrop-blur text-content dark:text-mortar-100">
            {badge}
          </span>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-0.5">
        <div className="font-medium text-content dark:text-mortar-100 truncate">
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-muted dark:text-slate-400 truncate">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
