// A schedule's reminder on the calendar: a nudge some days before the job is
// due, never a deadline of its own. Read as a deadline (no direction), Up next
// called a reminder OVERDUE five days ago while the job itself was due in
// two (#8869). A record never goes red once its day passes, which is what a
// reminder is: the due date carries the lateness.
import type { CalendarEvent } from "@cobblr/platform-contract";

export function reminderEventOf(due: CalendarEvent, entryId: string, name: string, day: string): CalendarEvent {
  return { ...due, id: `maintenance-reminder:${entryId}`, title: `Reminder: ${name}`, date: day, direction: "record" };
}
