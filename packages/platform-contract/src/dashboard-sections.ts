// The admin dashboard's sections, in their default order, with the words the
// dashboard says them in. One list for the dashboard (web/src/pages/Dashboard.tsx)
// and the assistant's platform:arrange-dashboard, so a section the screen
// gains is one the assistant can name.
export const DASHBOARD_SECTION_IDS = ["up_next", "at_a_glance", "pinned_views", "scan_inbox", "recent_activity"] as const;
export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];
export const DASHBOARD_SECTION_TITLE: Record<DashboardSectionId, string> = {
  up_next: "up next",
  at_a_glance: "at a glance",
  pinned_views: "your views",
  scan_inbox: "from your scanner",
  recent_activity: "recent activity",
};

/** How many entries Recent activity reads a page at a time. The dashboard's
 *  snapshot reads the same page, so the section is answered by it: the
 *  snapshot read 50 while the section asked for 100, and every dashboard load
 *  sent the activity read itself (#7622). */
export const RECENT_ACTIVITY_PAGE = 100;
