// /me/s/:section — one section of "Your account". Lists the destinations that
// belong to it, with their descriptions.
//
// The direct mirror of ConfigSectionPage, and it exists for the same reason the
// hub's cards do: a card you cannot click is a heading pretending to be a
// control ("I can't click on a top level card. config allows this."). Sending
// the card at its first leaf instead would make "You" mean "Identity", which is
// only true until someone reorders the list.

import { Link, Navigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { accountSections, ACCOUNT_SECTION_ORDER, type AccountSection } from "../lib/account-nav";

export function AccountSectionPage() {
  const { section } = useParams<{ section: string }>();
  const { activeOrg } = useActiveOrg();
  const known = ACCOUNT_SECTION_ORDER.includes(section as AccountSection);
  const hit = accountSections({ appMode: !!activeOrg?.app_mode }).find((s) => s.id === section);

  usePageTitle(hit?.meta.label ?? "Your account");

  // Unknown, or a section this user cannot see (a locked managed app hides the
  // platform ones). Both mean "not yours to be on" — back to the hub.
  if (!known || !hit) return <Navigate to="/me" replace />;

  const Icon = hit.meta.icon;

  return (
    <div className="space-y-5">
      <Link
        to="/me"
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ChevronLeft size={13} /> all of your account
      </Link>

      <div className="flex items-center gap-3 border-b border-line dark:border-slate-700 pb-3">
        <span className="w-9 h-9 rounded-lg bg-accent/10 text-accent grid place-items-center shrink-0">
          <Icon size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            {hit.meta.label}
          </h1>
          <p className="text-xs text-faint dark:text-slate-500 mt-0.5">{hit.meta.blurb}</p>
        </div>
        {hit.meta.action && (
          <Link
            to={hit.meta.action.to}
            className="ml-auto shrink-0 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5"
          >
            {hit.meta.action.label}
          </Link>
        )}
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-700 overflow-hidden">
        {hit.items.map((r) => (
          <Link
            key={r.to}
            to={r.to}
            className="flex items-start gap-3 px-4 py-3.5 hover:bg-subtle dark:hover:bg-slate-800/60 transition"
          >
            <r.icon size={18} className="text-accent mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm text-content dark:text-mortar-100">{r.label}</div>
              <div className="text-xs text-content dark:text-mortar-200 mt-0.5">{r.description}</div>
            </div>
            <ChevronRight size={14} className="shrink-0 text-faint dark:text-slate-500 mt-1" />
          </Link>
        ))}
      </div>
    </div>
  );
}
