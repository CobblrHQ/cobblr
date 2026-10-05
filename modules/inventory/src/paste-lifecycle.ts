import { z } from "zod";
import { dayIn } from "@cobblr/platform-contract/day";
const hour = 3_600_000;
export const PasteLimits = z.object({
  warmup_hours: z.number().finite().positive().max(72).default(4),
  work_life_hours: z.number().finite().positive().max(8760),
  expires_on: z.string().date(),
  timezone: z.string().min(1).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid storage timezone."),
  lot: z.string().trim().min(1).max(160),
});
export const PasteState = PasteLimits.extend({
  mode: z.enum(["cold", "out"]),
  exposed_ms: z.number().finite().nonnegative(),
  changed_at: z.string().datetime(),
  out_at: z.string().datetime().nullable(),
  opened_at: z.string().datetime().nullable(),
});
export type PasteClock = z.infer<typeof PasteState>;
export function beginPasteClock(limits: z.input<typeof PasteLimits>, now: Date): PasteClock {
  return { ...PasteLimits.parse(limits), mode: "cold", exposed_ms: 0, changed_at: now.toISOString(), out_at: null, opened_at: null };
}
export function pasteReadiness(input: PasteClock, now: Date) {
  const state = PasteState.parse(input);
  const changed = Date.parse(state.changed_at);
  if (!Number.isFinite(now.getTime()) || changed > now.getTime() || state.out_at && Date.parse(state.out_at) > now.getTime() || state.opened_at && Date.parse(state.opened_at) > now.getTime()) throw new Error("The paste clock is ahead of the server clock. Check the jar before use.");
  const exposed = state.exposed_ms + (state.mode === "out" ? now.getTime() - changed : 0);
  const warmed = state.mode === "out" && state.out_at !== null && now.getTime() - Date.parse(state.out_at) >= state.warmup_hours * hour;
  const expired = dayIn(now, state.timezone) > state.expires_on;
  const usedUp = exposed >= state.work_life_hours * hour;
  const usable = !expired && !usedUp && warmed;
  const reason = expired ? "This paste has passed its shelf expiry." : usedUp ? "This paste has exceeded its work life." : state.mode === "cold" ? "Take this paste out of the refrigerator before use." : !warmed ? "This paste is still warming up." : null;
  return { usable, reason, exposed_hours: exposed / hour, remaining_hours: Math.max(0, state.work_life_hours - exposed / hour), ready_at: state.out_at ? new Date(Date.parse(state.out_at) + state.warmup_hours * hour).toISOString() : null, expired };
}
export function changePasteStorage(input: PasteClock, operation: "out" | "cold" | "open", now: Date): PasteClock {
  const state = PasteState.parse(input);
  const ready = pasteReadiness(state, now);
  if (operation === "open") {
    if (!ready.usable) throw new Error(ready.reason ?? "Check the paste before opening it.");
    if (state.opened_at) return state;
    return { ...state, opened_at: now.toISOString() };
  }
  if (operation === "cold" && state.opened_at) throw new Error("This jar is opened. Do not return it to refrigeration; keep its work-life clock.");
  if (state.mode === operation) return state;
  return { ...state, mode: operation, exposed_ms: ready.exposed_hours * hour, changed_at: now.toISOString(), out_at: operation === "out" ? now.toISOString() : null };
}
