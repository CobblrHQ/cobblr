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
  /** Optional ember-tinted border when the row wants attention
   *  (low-stock, blocked, expired). */
  attention?: boolean;
}

export function EntityTile({ src, title, subtitle, badge, attention }: Props) {
  const borderCls = attention
    ? "border-ember-300 dark:border-ember-700"
    : "border-slate-200 dark:border-slate-700";
  // Internal /api/v1/files URLs need Bearer auth, so route them
  // through useImageSrc which blob-loads them. External URLs and
  // null both pass through unchanged.
  const resolved = useImageSrc(src);
  return (
    <div
      className={`rounded-xl overflow-hidden border bg-white dark:bg-slate-900 hover:border-cobble-400 dark:hover:border-cobble-600 transition flex flex-col h-full ${borderCls}`}
    >
      <div className="aspect-square relative bg-slate-50 dark:bg-slate-800">
        {resolved ? (
          <img
            src={resolved}
            alt={title}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-3xl font-mono text-slate-300 dark:text-slate-600">
            {title.trim().slice(0, 1).toUpperCase() || "?"}
          </div>
        )}
        {badge && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-white/85 dark:bg-slate-900/85 backdrop-blur text-slate-700 dark:text-mortar-100">
            {badge}
          </span>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-0.5">
        <div className="font-medium text-slate-700 dark:text-mortar-100 truncate">
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
