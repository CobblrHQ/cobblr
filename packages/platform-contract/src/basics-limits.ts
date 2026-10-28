import { z } from "zod";

/** The longest message Cobb's no-AI matcher reads. The route refuses past it
 *  and the panel checks it before sending, from this one number, so the two
 *  can never disagree about what fits (#7599). */
export const BASICS_MESSAGE_MAX = 2000;

/** The prior turn the panel sends with a no-AI answer, so control words
 *  (yes, again, undo) can point at something. The route parses it with this
 *  schema and the panel builds it against the same one, so a handle the
 *  route refuses cannot be sent (#8811: a "-" placeholder was refused and
 *  "undo that" fell through to the model). */
export const BasicPriorSchema = z.object({
  offered: z.object({ id: z.string().max(64), message: z.string().max(BASICS_MESSAGE_MAX) }).optional(),
  ran: z.object({ id: z.string().max(64), message: z.string().max(BASICS_MESSAGE_MAX) }).optional(),
  ledger_ids: z.array(z.string().uuid()).max(50).optional(),
});
export type BasicPrior = z.infer<typeof BasicPriorSchema>;

/** A handle no change ever has: asks whether a message is an undo when the
 *  newest thing on screen is a card nobody confirmed. The act it gets back
 *  is read for its kind and never run. */
export const NOTHING_DONE_YET = "00000000-0000-0000-0000-000000000000";
