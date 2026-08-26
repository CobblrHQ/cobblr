// The ONE header every /me leaf page wears — drawn by the layout from the
// account registry, exactly as ConfigPageHeader does for /configuration.
//
// AccountLayout's own comment cites ConfigPageHeader as the reason a per-page
// decision drifts, and then the header half was never built: 13 pages hand-
// rolled their <h1> and split into two font dialects and two casing
// conventions, 8 of them with no way back to /me at all. Same failure, same
// fix: the page renders content, the layout renders identity.
//
// The hub (/me) and the section pages (/me/s/:x) draw nothing here — they ARE
// navigation, and a header naming them would repeat the card the user just
// clicked. Only a registered leaf destination gets the crumb + header.

import { NavLink, useLocation } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import {
  ACCOUNT_DESTINATIONS,
  ACCOUNT_SECTIONS,
} from "../lib/account-nav";

function leafFor(pathname: string) {
  // Longest match, so /me/connections/new inherits /me/connections' header.
  return ACCOUNT_DESTINATIONS.filter(
    (d) => pathname === d.to || pathname.startsWith(`${d.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];
}

export function AccountCrumb() {
  const { pathname } = useLocation();
  const here = leafFor(pathname);
  if (!here) return null;
  const section = ACCOUNT_SECTIONS[here.section];
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-xs text-faint dark:text-slate-500 mb-3"
    >
      <NavLink to="/me" className="inline-flex items-center gap-1 hover:text-accent">
        <ChevronLeft size={13} /> Your account
      </NavLink>
      <span aria-hidden>›</span>
      <NavLink to={`/me/s/${here.section}`} className="hover:text-accent">
        {section.label}
      </NavLink>
      <span aria-hidden>›</span>
      <span className="text-content/70 dark:text-mortar-200 truncate">{here.label}</span>
    </nav>
  );
}

export function AccountPageHeader() {
  const { pathname } = useLocation();
  const here = leafFor(pathname);
  if (!here) return null;
  const Icon = here.icon;
  return (
    <header className="mb-5">
      <div className="flex items-start gap-3">
        <Icon size={22} className="mt-0.5 shrink-0 text-accent dark:text-cobble-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            {here.label}
          </h1>
          <p className="page-subtitle mt-0.5">{here.description}</p>
        </div>
      </div>
    </header>
  );
}
