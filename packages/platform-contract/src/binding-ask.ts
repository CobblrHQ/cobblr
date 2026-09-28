// A button a collection puts on its own records: an existing action, with
// fixed arguments, under its own label, asking for what only the person
// knows before it runs ("Open a bottle" asks for a tasting note).
//
// One shape for every door that writes a user-invoked binding (a bundle's
// wires, the Wires page, a blueprint) and the one reader of what is stored,
// so a question written by one is asked by all.

import { z } from "zod";

/** A button label: short, because it is a chip on a phone. */
export const BindingLabel = z.string().trim().min(1).max(40);

/** One question asked before the action runs; its answer is passed as the
 *  action's `arg`. Never required: an empty answer runs the action without
 *  it, because a button that cannot be pressed without typing is not a
 *  shortcut. */
export const BindingAskEntry = z.object({
  arg: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, "an argument name, like note"),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(["text", "number"]).default("text"),
  placeholder: z.string().max(80).optional(),
});
export type BindingAskEntry = z.infer<typeof BindingAskEntry>;

export const BindingAsk = z.array(BindingAskEntry).max(3);

/** What a stored binding asks, read tolerantly: a row written before the
 *  column existed, or one somebody edited by hand, asks nothing rather than
 *  breaking the button. */
export function bindingAskOf(raw: unknown): BindingAskEntry[] {
  const r = BindingAsk.safeParse(raw);
  return r.success ? r.data : [];
}

/** The answers, as the action's arguments: blanks left out, a number field
 *  as a number. */
export function answersToArgs(ask: readonly BindingAskEntry[], answers: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of ask) {
    const v = (answers[q.arg] ?? "").trim();
    if (!v) continue;
    if (q.kind === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[q.arg] = n;
    } else out[q.arg] = v.slice(0, 1000);
  }
  return out;
}
