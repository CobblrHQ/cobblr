import { z } from "zod";
import { instantFromInput } from "@cobblr/platform-contract/day";

export const CounterReading = z.number().finite().nonnegative().nullable().optional();

export const CompletionBody = z.object({
  counter_reading: CounterReading,
  performed_at: z.string().refine(value => {
    const text = value.trim();
    const at = instantFromInput(text);
    return at !== null && at.getTime() <= Date.now() + 24 * 60 * 60_000 && (!/^\d{4}-\d{2}-\d{2}/.test(text) || instantFromInput(text.slice(0, 10)) !== null);
  }, { message: "Give a day (YYYY-MM-DD) or a date and time for when the service was done, not in the future." }).optional(),
});
