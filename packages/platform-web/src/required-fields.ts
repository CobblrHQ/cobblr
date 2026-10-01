// Which required fields a record, or a form about to make one, has no value in.
//
// A create may leave a required field empty (capture comes before structure:
// a scan or "add a part called X" is never refused for it), so a person's New
// form asks for them before saving and offers to save anyway, and a list says
// how many of its records still need one. One reading of "empty" for both.

export interface RequiredLike {
  name: string;
  display_label: string;
  required?: boolean | null;
  type?: string;
}

const empty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** The required fields with nothing in them. `values` is the record's
 *  metadata (or a form's draft), with top-level values read as a fallback. */
export function missingRequired<T extends RequiredLike>(defs: readonly T[], values: Record<string, unknown> | null | undefined, topLevel?: Record<string, unknown> | null): T[] {
  return defs.filter((d) => d.required && d.type !== "computed" && empty(values?.[d.name]) && empty(topLevel?.[d.name]));
}
