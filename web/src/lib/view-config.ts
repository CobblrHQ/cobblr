// Which config keys a saved view keeps, in one place.
//
// The New view and Edit view forms each wrote their own list of "this layout
// keeps these keys", and the two drifted: editing a table view deleted its
// group_by (the table renderer reads it; the edit form only kept it for a
// kanban), and neither form could give a table one. Both forms now build the
// layout half of a config here, from one table of what each renderer reads.

export type ViewType = "list" | "table" | "kanban" | "trend" | "calendar" | "gantt" | "gallery" | "heatmap" | "vending";

/** The layout keys each view type's renderer reads (web/src/pages/ViewsPage.tsx). */
export const LAYOUT_KEYS: Record<ViewType, readonly string[]> = {
  list: [],
  table: ["visible_fields", "group_by"],
  kanban: ["group_by"],
  calendar: ["date_field", "title_field"],
  gantt: ["start_field", "end_field", "title_field"],
  gallery: ["image_field", "caption_field"],
  trend: ["x", "y", "goal"],
  heatmap: ["date_field", "expect_rrule"],
  vending: ["qty_field", "expiry_field", "min_qty_field", "grace_field", "image_field"],
};

const EVERY_LAYOUT_KEY = new Set(Object.values(LAYOUT_KEYS).flat());

function empty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

/**
 * A view's config after its layout form is saved.
 *  - A key the chosen type reads takes the form's value, trimmed; an empty
 *    value removes it. A key the form has no input for is kept as it was.
 *  - A layout key only another type reads is dropped (it would mean nothing).
 *  - Everything that is not layout (filter, where, sort, anything newer) is
 *    kept as it was.
 */
export function layoutConfig(type: ViewType, previous: Record<string, unknown>, form: Record<string, unknown>): Record<string, unknown> {
  const reads = new Set(LAYOUT_KEYS[type]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(previous)) {
    if (EVERY_LAYOUT_KEY.has(k) && !reads.has(k)) continue;
    out[k] = v;
  }
  for (const k of reads) {
    if (!(k in form)) continue;
    const v = form[k];
    if (empty(v)) delete out[k];
    else out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}
