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

import { quantityNumber } from "@cobblr/platform-contract/quantity-number";
import type { ReactNode } from "react";
import { EntityPhoto } from "./EntityPhoto";
import { PICTURE_STATE_TEXT, type PictureState } from "./photoSuggestions";
import type { SwatchFieldDef } from "./swatch-pick";

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
  /** A picture the platform found for a record that has none (#3818). Shown
   *  only while the record has no picture of its own, and marked as a
   *  suggestion, never passed off as the record's own. */
  suggestedSrc?: string | null;
  /** With no picture and no suggestion: whether one is still being looked
   *  for, or was looked for and not found (pictureStateFor). */
  pictureState?: PictureState;
  /** How many identical things the record stands for (a record of three
   *  printers). Drawn as "×3" on the image's top-left, apart from `badge`,
   *  and only above one: "×1" on every single machine is noise. Stock that
   *  runs down (a pantry's count) is a `badge`, which shows every value. */
  count?: number | null;
}

/** The "×N" a tile shows for a record standing for N things, or null. */
export function countBadge(count: number | null | undefined): string | null {
  return typeof count === "number" && Number.isFinite(count) && count > 1 ? `×${quantityNumber(count)}` : null;
}

export function EntityTile({ src, title, subtitle: rawSubtitle, badge, color, values, fieldDefs, attention, status, suggestedSrc, pictureState, count }: Props) {
  const suggesting = !src && !!suggestedSrc;
  const saying = !src && !suggesting ? pictureState : undefined;
  const subtitle = distinctSubtitle(title, rawSubtitle);
  const times = countBadge(count);
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
      <EntityPhoto src={suggesting ? suggestedSrc : src} alt={title} aspect="square" color={color} values={values} fieldDefs={fieldDefs}>
        {suggesting && <span className="pointer-events-none absolute inset-1 rounded-lg border-2 border-dashed border-accent/70" />}
        {/* One stack on the top-left, so a record of three whose picture is
            suggested, or still being looked for, says both, one under the
            other, never one over the other. */}
        {(suggesting || saying || times) && (
          <span className="absolute top-1.5 left-1.5 right-1.5 flex flex-col items-start gap-1 pointer-events-none">
            {suggesting && (
              <span data-testid="tile-suggested" className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-white">
                Suggested
              </span>
            )}
            {saying && (
              <span
                data-testid="tile-picture-state"
                data-state={saying}
                className={`max-w-full truncate px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface/85 dark:bg-slate-900/85 text-muted dark:text-slate-300${saying === "looking" ? " animate-pulse" : ""}`}
              >
                {PICTURE_STATE_TEXT[saying]}
              </span>
            )}
            {times && (
              <span data-tile-count className="px-1.5 py-0.5 rounded text-[11px] font-mono font-medium bg-surface/85 dark:bg-slate-900/85 backdrop-blur text-content dark:text-mortar-100">
                {times}
              </span>
            )}
          </span>
        )}
        {badge && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-surface/85 dark:bg-slate-900/85 backdrop-blur text-content dark:text-mortar-100">
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
        {status && (
          <div
            data-tile-status
            className="mt-auto pt-1 min-w-0 truncate"
            // A tile is usually wrapped in the link to its record. A control
            // in the status line (a count's −/+) must act, not open the
            // record: the tap is kept from the link here, in the capture
            // phase, since a control may stop its own click from bubbling. A
            // link in the status line still follows.
            onClickCapture={(e) => {
              const t = e.target as HTMLElement;
              const link = t.closest("a");
              const ownLink = !!link && e.currentTarget.contains(link);
              if (t.closest("button, input, select, textarea") && !ownLink) e.preventDefault();
            }}
          >
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
