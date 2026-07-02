// AreaTabs (B1/B2 consolidation) — a small segmented strip that makes a
// FAMILY of related pages read as one area. The 2026-07 settings audit found
// access control spread over four disconnected surfaces and notifications
// over three; rather than rewriting working editors into one mega-page, each
// page keeps its route + internals and wears the same strip, so moving
// within the family is one click and the family has one name.
//
// Deliberately dumb: a list of {label, to}, current one highlighted by exact
// path match. Reused verbatim by both families; add a third family by
// exporting another constant.

import { Link, useLocation } from "react-router-dom";

export interface AreaTab {
  label: string;
  to: string;
}

export const ACCESS_TABS: AreaTab[] = [
  { label: "Overview & grants", to: "/configuration/permissions" },
  { label: "Custom roles", to: "/configuration/roles" },
  { label: "Accounts", to: "/configuration/users" },
];

export const NOTIFICATION_TABS: AreaTab[] = [
  { label: "Inbox", to: "/me/notifications" },
  { label: "Delivery", to: "/me/communication" },
  { label: "Channels", to: "/me/notification-channels" },
];

export function AreaTabs({ tabs, area }: { tabs: AreaTab[]; area: string }) {
  const { pathname } = useLocation();
  return (
    <div className="flex items-center gap-1 mb-4">
      <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mr-2">
        {area}
      </span>
      {tabs.map((t) => {
        const on = pathname === t.to;
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={on ? "page" : undefined}
            className={
              "rounded-full px-3 py-1 text-xs font-medium transition " +
              (on
                ? "bg-accent/10 text-accent"
                : "text-content/70 dark:text-mortar-200 hover:bg-surface dark:hover:bg-slate-800 border border-line dark:border-slate-700")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
