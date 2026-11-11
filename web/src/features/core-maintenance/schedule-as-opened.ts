// What a schedule's edit form opened with, as update-schedule's args name it:
// sent as edited_from so a save over a teammate's change since is refused,
// not written over it (#9446).
import type { MaintenanceSchedule } from "../../lib/api";

export function scheduleAsOpened(s: MaintenanceSchedule): Record<string, unknown> {
  return {
    name: s.name,
    remind: s.remind ?? null,
    overdue_every: s.overdue_every ?? null,
    every_n: s.every_n ?? null,
    every_unit: s.every_unit ?? null,
    counter_field: s.counter_field ?? null,
    counter_every: s.counter_every ?? null,
  };
}
