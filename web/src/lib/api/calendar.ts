import { request } from "./client";
import type { CalendarEvent } from "@cobblr/platform-contract";

export type { CalendarEvent } from "@cobblr/platform-contract";
export interface CalendarFeed {
  enabled: boolean;
  token: string | null;
  url: string | null;
}

export const calendarApi = {

  // workspace calendar
  calendarEvents: (slug: string, from: string, to: string) =>
    request<{ items: CalendarEvent[]; from: string; to: string }>(
      "GET",
      `/orgs/${slug}/calendar/events?from=${from}&to=${to}`,
    ),
  getWarrantyReminders: (slug: string) =>
    request<{ enabled: boolean }>("GET", `/orgs/${slug}/calendar/reminders`),
  setWarrantyReminders: (slug: string, enabled: boolean) =>
    request<{ enabled: boolean }>("PUT", `/orgs/${slug}/calendar/reminders`, { enabled }),
  getCalendarFeed: (slug: string) =>
    request<CalendarFeed>("GET", `/orgs/${slug}/calendar/feed`),
  setCalendarFeed: (slug: string, enabled: boolean) =>
    request<CalendarFeed>("PUT", `/orgs/${slug}/calendar/feed`, { enabled }),
  rotateCalendarFeed: (slug: string) =>
    request<CalendarFeed>("POST", `/orgs/${slug}/calendar/feed/rotate`, {}),
};
