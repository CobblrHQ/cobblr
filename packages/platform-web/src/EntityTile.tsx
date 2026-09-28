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
import { EntityPhoto } from "./EntityPhoto";
import type { SwatchFieldDef } from "./swatch";

/** The grid every wall of tiles sits in: two across on a phone, and above that
 *  as many ~180px columns as fit, so a desktop wall is a wall of slots rather
 *  than five posters at 370px each. One string, so every gallery, card wall and
 *  vending wall packs the same way. */
export const TILE_GRID = "grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]";

/** A tile's name: two lines before it is cut, two lines kept for every title
 *  so the line under it sits at one height along a row, the whole name on
 *  hover (pass `title`). One line cut a name that had the room below it
 *  ("XYZprinting da Vi…", #3884). One string for every tile wall; the tile
 *  e2e (photo-tiles-never-stretch.mjs) holds the behaviour on each. */
export const TILE_TITLE = "font-medium leading-snug text-content dark:text-mortar-100 line-clamp-2 break-words min-h-[2lh]";

/** The line under a name, or null when it only says the name again. A machine
 *  whose model is its name ("DICE" / "DICE") read as a stutter on every tile. */
export function distinctSubtitle(title: string, subtitle: string | null | undefined): string | null {
  const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
  if (!subtitle || !subtitle.trim()) return null;
  return norm(subtitle) === norm(title) ? null : subtitle;
}

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
  /** A live status line (a printer's "● printing 46%"). It sits INSIDE the
   *  card, on the card's bottom line, so every tile along a row puts it at the
   *  same height; drawn beside the card it hung below the box. */
  status?: ReactNode;
}

export function EntityTile({ src, title, subtitle: rawSubtitle, badge, color, values, fieldDefs, attention, status }: Props) {
  const subtitle = distinctSubtitle(title, rawSubtitle);
  const borderCls = attention
    ? "border-ember-300 dark:border-ember-700"
    : "border-line dark:border-slate-700";
  return (
    <div
      data-testid="entity-tile"
      className={`rounded-xl overflow-hidden border bg-surface dark:bg-slate-900 hover:border-accent dark:hover:border-cobble-600 transition flex flex-col h-full ${borderCls}`}
    >
      {/* The square comes from the frame, before the picture: a tall photo
          cannot make its tile taller than the one beside it. */}
      <EntityPhoto src={src} alt={title} aspect="square" color={color} values={values} fieldDefs={fieldDefs}>
        {badge && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-surface/85 dark:bg-slate-900/85 backdrop-blur text-content dark:text-mortar-100">
            {badge}
          </span>
        )}
      </EntityPhoto>
      <div className="p-3 flex-1 flex flex-col gap-0.5">
        <div data-tile-title title={title} className={TILE_TITLE}>
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-muted dark:text-slate-400 truncate">
            {subtitle}
          </div>
        )}
        {status && <div data-tile-status className="mt-auto pt-1 min-w-0 truncate">{status}</div>}
      </div>
    </div>
  );
}
