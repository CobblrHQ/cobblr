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
