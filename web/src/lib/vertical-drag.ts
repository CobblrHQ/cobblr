// A drag in a list moves up and down, inside the list, and nowhere else.
//
// dnd-kit moves the dragged row by the pointer's whole offset, sideways too.
// In the sidebar that carried a row off to the right; the row widened the
// nav's content, the auto-scroller scrolled toward it, the scroll moved the
// row further, and the horizontal scrollbar grew for as long as the pointer
// stayed there (the owner, 2026-10-01, #4514). With no sideways offset there
// is nothing to widen and nothing to scroll toward. A reorder in a vertical
// list has no use for x, so every vertical list spreads these props into its
// DndContext; lint:vertical-drag-stays-in-its-column holds it.
//
// Not autoScroll's threshold: an x threshold of 0 divides by zero inside
// dnd-kit and scrolls at Infinity once the pointer is past the edge.
import type { ClientRect, DndContextProps, Modifier } from "@dnd-kit/core";

/** Where the dragged row may go: no sideways offset, and its top and bottom
 *  inside `bounds` (the list's own scroller). Pure, for the test. */
export function keepInColumn(
  transform: { x: number; y: number; scaleX: number; scaleY: number },
  row: Pick<ClientRect, "top" | "bottom"> | null,
  bounds: Pick<ClientRect, "top" | "bottom"> | null,
) {
  const out = { ...transform, x: 0 };
  if (!row || !bounds) return out;
  if (row.top + out.y < bounds.top) out.y = bounds.top - row.top;
  else if (row.bottom + out.y > bounds.bottom) out.y = bounds.bottom - row.bottom;
  return out;
}

const inColumn: Modifier = ({ transform, draggingNodeRect, scrollableAncestorRects, containerNodeRect }) =>
  keepInColumn(transform, draggingNodeRect, scrollableAncestorRects[0] ?? containerNodeRect);

/** Spread into a DndContext whose lists are all vertical. */
export const VERTICAL_DRAG: Pick<DndContextProps, "modifiers"> = {
  modifiers: [inColumn],
};
