import { z } from "zod";
import { instantFromInput } from "@cobblr/platform-contract/day";

export const CounterReading = z.number().finite().nonnegative().nullable().optional();

export const CompletionBody = z.object({
  counter_reading: CounterReading,
  performed_at: z.string().refine(value => {
    const text = value.trim();
    return instantFromInput(text) !== null && (!/^\d{4}-\d{2}-\d{2}/.test(text) || instantFromInput(text.slice(0, 10)) !== null);
  }, { message: "Give a valid day (YYYY-MM-DD) or a date and time for when the service was done." }).optional(),
});
