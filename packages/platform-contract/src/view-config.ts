// What a saved view's config may hold. Each door that saves one asks
// viewConfigProblem, and each page that draws one reads readableViewConfig,
// because a store can hold what an older build or a hand-written call left: a
// column list that was not a list took the view to the error screen.
import { normalizeGrouping } from "@cobblr/platform-contract/grouped-list";

const FIELD_KEYS = [
  "date_field", "title_field", "start_field", "end_field", "image_field", "caption_field",
  "x", "y", "qty_field", "expiry_field", "min_qty_field", "grace_field", "expect_rrule", "sort_by",
] as const;

const groupingProblem = (raw: unknown): string | null => {
  try {
    normalizeGrouping(raw);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

function keyProblem(key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if ((FIELD_KEYS as readonly string[]).includes(key)) return typeof value === "string" ? null : `${key} has to name a field`;
  if (key === "visible_fields") return Array.isArray(value) && value.every((f) => typeof f === "string") ? null : "visible_fields has to be a list of field names";
  if (key === "group_by") {
    const why = groupingProblem(value);
    return why ? `group_by: ${why}` : null;
  }
  if (key === "goal") return typeof value === "number" && Number.isFinite(value) ? null : "goal has to be a number";
  if (key === "filter") return typeof value === "object" && !Array.isArray(value) ? null : "filter has to be a set of field values";
  if (key === "where") return Array.isArray(value) && value.every((p) => p && typeof p === "object" && !Array.isArray(p)) ? null : "where has to be a list of conditions";
  return null;
}

export function viewConfigProblem(config: unknown): string | null {
  if (config === undefined || config === null) return null;
  if (typeof config !== "object" || Array.isArray(config)) return "A view's config has to be a set of settings";
  for (const [key, value] of Object.entries(config)) {
    const why = keyProblem(key, value);
    if (why) return why;
  }
  return null;
}

/** A stored config with whatever can't be read taken out: the view opens as if that setting were never made. */
export function readableViewConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => !keyProblem(key, value)));
}
