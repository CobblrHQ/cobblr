// core-calendar: the workspace calendar, everything with a date in one view
// (service visits, renewals, dated fields, a view's dates), and its private
// iCal feed.
//
// Like core-activity-log, this manifest declares ownership of platform code:
// the calendar is read across every module's dated fields, so it lives at
// api/src/platform/date-field-calendar.ts and api/src/routes/calendar.ts,
// and its page at web/src/pages/CalendarPage.tsx. Before this manifest the
// calendar was the one page no module declared, so it was missing from every
// list the app builds from the module registry: All apps, the search
// palette, Menu & surfaces, and so the phone menu (#5971).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-calendar",
  version: "0.1.0",
  displayName: "Calendar",
  description: "Everything with a date in one view: service visits, renewals and due dates, with a feed for your own calendar app.",
  icon: "calendar",
  band: "stock",
  autoEnable: true, // ambient capability: on for every workspace, like Views

  // Browse-not-configure: a page you visit. Not `primary`: like Views and
  // Files it is a door a person adds to their menu (docs/design-decisions/
  // nav-collapse.md), found in All apps and the search palette until then.
  nav: {
    label: "Calendar",
    route: "/calendar",
    icon: "calendar",
  },

  dependencies: [],

  // AI-REACH: no kinds/actions by design. The calendar is READ through the
  // shared registry's list_calendar tool; an event is the record that owns
  // the date, created and changed through that record's own module.

  exposes: {
    events: [],
    actions: [],
  },

  subscribes: [],
});
