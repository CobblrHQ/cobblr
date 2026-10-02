// The colours a place can wear on a floor plan (#4564).
//
// A person groups places by colour (every drawer of the red tool chest is red),
// so a colour is theirs to set, from the plan's Edit layout or by asking the
// assistant, and the plan's legend says which places carry it. A short named
// list, never a free hex: the plan draws each one in both themes, and the
// assistant can say "red" and mean the same red the swatch shows. The list
// lives here so the module that stores the colour and the page that draws it
// cannot disagree about what a colour is.

export const PLAN_COLOURS = ["red", "orange", "yellow", "green", "blue", "purple", "grey"] as const;
export type PlanColour = (typeof PLAN_COLOURS)[number];

export function isPlanColour(v: unknown): v is PlanColour {
  return typeof v === "string" && (PLAN_COLOURS as readonly string[]).includes(v);
}

/** A colour as a person might say it ("Red", "gray", "violet"), or null. */
export function readPlanColour(v: unknown): PlanColour | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  const alias: Record<string, PlanColour> = { gray: "grey", violet: "purple", amber: "orange" };
  const c = alias[s] ?? s;
  return isPlanColour(c) ? c : null;
}

/** The colour a place wears, read from its metadata. */
export function planColourOf(metadata: unknown): PlanColour | null {
  const fp = (metadata as { floorplan?: { color?: unknown } } | null | undefined)?.floorplan;
  return isPlanColour(fp?.color) ? fp.color : null;
}
