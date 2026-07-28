import { createPortal } from "react-dom";
import { renderPrintSheetFragment } from "./renderPrintSheet";
import type { CustomLabelSize, Printable } from "./api";

/** An off-DOM print layer for the Labels page. Portaled as a DIRECT child of
 *  <body> so the fragment's `body > *:not(.labels-print-layer)` rule can hide the
 *  whole app during print and leave only the sheet. Hidden on screen; visible only
 *  in print. Because it mounts only while the Labels preview is on screen, its
 *  @page + isolation rules never touch printing on any other page.
 *
 *  This replaces a hidden print iframe: Chrome printed the whole parent document
 *  when we called contentWindow.print() on that iframe. The @media-print pattern
 *  (see PlanPrintPage) is what the rest of the app uses, and — unlike the iframe —
 *  it also makes the browser's own ⌘P print just the sheet. */
export function LabelPrintLayer({
  printables,
  sizeKey,
  customSizes,
  rotate,
}: {
  printables: Printable[];
  sizeKey: string;
  customSizes?: CustomLabelSize[];
  rotate?: boolean;
}) {
  if (typeof document === "undefined" || printables.length === 0) return null;
  const html = renderPrintSheetFragment(printables, sizeKey, { customSizes, rotate });
  if (!html) return null;
  return createPortal(
    <div className="labels-print-layer" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />,
    document.body,
  );
}
