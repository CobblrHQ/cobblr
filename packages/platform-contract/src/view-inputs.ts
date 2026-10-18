// A view's inputs (#6897): named, typed, bounded values the viewer sets at read
// time, which the view's computed fields read as {{ inputs.<name> }}. A recipe
// view's "Servings ×" doubles every amount on the page. Read-only, always: an
// input changes what is shown, never what is stored. Held in the URL, so a
// scaled view is a link.
//
// One resolver for every door (the view's data route, the page, the
// assistant): what was asked for, bounded by what the view declares, with a
// note for each value it had to change, so a clamp is said, never silent.
import { z } from "zod";

export const VIEW_INPUT_TYPES = ["number", "text", "date", "choice"] as const;
export type ViewInputType = (typeof VIEW_INPUT_TYPES)[number];

export const ViewInputSchema = z
  .object({
    /** What a template names it by: {{ inputs.scale }}. */
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a short lowercase name: letters, digits and _"),
    label: z.string().min(1).max(60),
    type: z.enum(VIEW_INPUT_TYPES),
    default: z.union([z.number(), z.string().max(200)]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** The values a `choice` input takes. */
    choices: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .refine((i) => i.min === undefined || i.max === undefined || i.min <= i.max, { message: "the least is more than the most" })
  .refine((i) => i.type !== "choice" || (i.choices?.length ?? 0) > 0, { message: "a choice needs its choices" });

export type ViewInput = z.infer<typeof ViewInputSchema>;

/** A view declares at most eight; each name once. */
export const ViewInputsSchema = z
  .array(ViewInputSchema)
  .max(8)
  .refine((list) => new Set(list.map((i) => i.name)).size === list.length, { message: "two inputs share a name" });

/** What a resolved input had to change, in words a page or the assistant says. */
export interface ViewInputNote {
  name: string;
  label: string;
  said: string;
  used: string | number;
  why: "above-most" | "below-least" | "not-a-number" | "not-a-date" | "not-a-choice";
  /** "Servings × 500 is more than the most this view takes, 100: showing 100." */
  message: string;
}

export interface ResolvedViewInputs {
  values: Record<string, string | number>;
  notes: ViewInputNote[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function defaultOf(i: ViewInput): string | number {
  if (i.default !== undefined) return i.default;
  if (i.type === "number") return i.min ?? 0;
  if (i.type === "choice") return i.choices?.[0] ?? "";
  return "";
}

/** The values the view's computed fields read: each declared input, from what
 *  was asked for when it fits, else bounded or defaulted with a note. A value
 *  for a name the view does not declare is ignored. */
export function resolveViewInputs(declared: readonly ViewInput[] | null | undefined, asked: Record<string, unknown> | null | undefined): ResolvedViewInputs {
  const values: Record<string, string | number> = {};
  const notes: ViewInputNote[] = [];
  for (const i of declared ?? []) {
    const raw = asked?.[i.name];
    const fallback = defaultOf(i);
    if (raw === undefined || raw === null || raw === "") {
      values[i.name] = fallback;
      continue;
    }
    const said = String(raw);
    const note = (used: string | number, why: ViewInputNote["why"], message: string) => {
      values[i.name] = used;
      notes.push({ name: i.name, label: i.label, said, used, why, message });
    };
    if (i.type === "number") {
      const n = typeof raw === "number" ? raw : /^\s*-?\d+(?:\.\d+)?\s*$/.test(said) ? Number(said) : NaN;
      if (!Number.isFinite(n)) note(fallback, "not-a-number", `${i.label} "${said}" is not a number: showing ${fallback}.`);
      else if (i.max !== undefined && n > i.max) note(i.max, "above-most", `${i.label} ${said} is more than the most this view takes, ${i.max}: showing ${i.max}.`);
      else if (i.min !== undefined && n < i.min) note(i.min, "below-least", `${i.label} ${said} is less than the least this view takes, ${i.min}: showing ${i.min}.`);
      else values[i.name] = n;
    } else if (i.type === "date") {
      if (DAY.test(said)) values[i.name] = said;
      else note(fallback, "not-a-date", `${i.label} "${said}" is not a date: showing ${fallback || "none"}.`);
    } else if (i.type === "choice") {
      if (i.choices?.includes(said)) values[i.name] = said;
      else note(fallback, "not-a-choice", `${i.label} "${said}" is not one of its choices: showing ${fallback}.`);
    } else {
      values[i.name] = said.slice(0, 200);
    }
  }
  return { values, notes };
}

/** The URL a view keeps its inputs in: `in.<name>=<value>`, one per input. */
export const VIEW_INPUT_PARAM = "in.";

/** What a page URL asks for, read back: `?in.scale=2` → { scale: "2" }. */
export function viewInputsFromSearch(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of search) if (k.startsWith(VIEW_INPUT_PARAM)) out[k.slice(VIEW_INPUT_PARAM.length)] = v;
  return out;
}
