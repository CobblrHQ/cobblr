// A tile you choose from, and how a chosen one looks, once (#4515).
//
// The scan inbox outlined the picture in use; the record's photo search drew
// a thicker border and a ring for the AI's pick and nothing for the photo in
// use; each picker grid had its own idea. The owner asked for the chosen
// tile to look the same everywhere, so it is drawn here: the scan inbox's
// accent outline when `selected`, and a corner slot for each badge (the AI
// mark, Your photo / Catalog photo, the main photo's star). The words for a
// screen reader ride on aria-current and the title, never on the picture.
// capabilities.ts (ui:the-chosen-tile) refuses a grid that draws its own.

import type { ReactNode } from "react";

/** The chosen tile's outline. Exported for the one surface that draws a
 *  tile it does not render through SelectableTile (none yet); prefer the
 *  component. */
export const SELECTED_TILE = "outline outline-2 outline-offset-1 outline-accent";

export interface SelectableTileProps {
  /** Chosen: the photo in use, the current pick. */
  selected?: boolean;
  /** What "chosen" means here, for a screen reader and the title ("In use"). */
  selectedLabel?: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  /** The tile's own size and frame, e.g. "w-20 h-20". */
  className?: string;
  /** The face behind the picture (a black frame for whole-shot photos). */
  faceClassName?: string;
  topLeft?: ReactNode;
  topRight?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}

export function SelectableTile({
  selected = false,
  selectedLabel = "Selected",
  onClick,
  disabled,
  title,
  "aria-label": ariaLabel,
  className = "w-20 h-20",
  faceClassName = "bg-white dark:bg-slate-100",
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
  children,
  "data-testid": testId,
}: SelectableTileProps) {
  const said = selected && title ? `${title} (${selectedLabel})` : selected ? selectedLabel : title;
  return (
    <div className={`relative shrink-0 group ${className}`} data-testid={testId} data-selected={selected ? "" : undefined}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={said}
        aria-label={ariaLabel ? (selected ? `${ariaLabel} (${selectedLabel})` : ariaLabel) : undefined}
        aria-current={selected ? "true" : undefined}
        className={`w-full h-full rounded overflow-hidden border border-line dark:border-slate-700 hover:border-cobble-400 transition disabled:opacity-50 ${faceClassName} ${selected ? SELECTED_TILE : ""}`}
      >
        {children}
      </button>
      {topLeft && <div className="absolute top-1 left-1 flex items-center gap-0.5">{topLeft}</div>}
      {topRight && <div className="absolute top-1 right-1 flex items-center gap-0.5">{topRight}</div>}
      {bottomLeft && <div className="absolute bottom-1 left-1 flex items-center gap-0.5">{bottomLeft}</div>}
      {bottomRight && <div className="absolute bottom-1 right-1 flex items-center gap-0.5">{bottomRight}</div>}
    </div>
  );
}
