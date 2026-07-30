// Persistent shell for every /configuration/* page — a grouped sidebar (from
// the ONE registry in lib/configuration-nav.ts) beside the routed page, so
// moving between settings never bounces back through the hub.
//
// Lives INSIDE AppLayout (unlike AdminLayout, which is its own top-level
// shell) — the workspace chrome stays; only the content column gains the
// sidebar.
//
// 2026-07 revamp: the sidebar groups by the five SECTIONS and hides exactly
// what the hub hides (same useConfigVisibility), so the two can't disagree
// about what this workspace contains. It used to show all 34 destinations flat
// while the hub showed 11 of them.
//
// On phones the rail collapses to a "jump to" <select> rather than vanishing:
// it used to be `hidden md:block`, which left a phone with no settings
// navigation at all once you were inside a page.

import { useMemo, useState, type ComponentType } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, Search, Settings2 } from "lucide-react";
import { iconForName as iconForPanel } from "../lib/panel-icons";
import { useNavMode } from "../lib/nav-mode";
import { useConfigVisibility } from "../lib/useConfigVisibility";
import { useHostedPanels } from "../lib/useHostedPanels";
import { ConfigHeaderProvider, ConfigPageHeader } from "./ConfigPageHeader";
import {
  CONFIG_SECTIONS,
  CONFIG_SECTION_ORDER,
  HOSTED_SECTION,
  columnFor,
  destinationMatches,
  sectionForPath,
  visibleDestinations,
  CONFIG_DESTINATIONS,
  type ConfigDestination,
} from "../lib/configuration-nav";

interface Entry {
  label: string;
  to: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  description?: string;
}

/** The configuration sidebar's CONTENT — hub link, settings search, the five
 *  sections (plus Cloud), each with the destinations this viewer can use. */
export function ConfigSidebarBody() {
  const location = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const ctx = useConfigVisibility();
  const { panels } = useHostedPanels();

  const groups = useMemo(() => {
    const all = visibleDestinations(ctx);
    const out: Array<{ id: string; label: string; entries: Entry[] }> =
      CONFIG_SECTION_ORDER.map((id) => ({
        id,
        label: CONFIG_SECTIONS[id].label,
        entries: all
          .filter((d: ConfigDestination) => d.section === id)
          .map((d) => ({
            label: d.label,
            to: d.to,
            icon: d.icon,
            description: d.description,
          })),
      }));
    if (panels.length > 0) {
      out.push({
        id: HOSTED_SECTION.id,
        label: HOSTED_SECTION.label,
        entries: panels.map((p) => ({
          label: p.label,
          to: `/configuration/x/${p.id}`,
          icon: iconForPanel(p.icon),
        })),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.enabledModules, ctx.role, panels]);

  const query = q.trim();
  const filtered = query
    ? groups
        .map((g) => ({
          ...g,
          entries: g.entries.filter((e) =>
            destinationMatches(
              { label: e.label, description: e.description ?? "", keywords: [] },
              query,
            ),
          ),
        }))
        .filter((g) => g.entries.length > 0)
    : groups.filter((g) => g.entries.length > 0);

  const firstHit = filtered[0]?.entries[0];
  const isActive = (to: string) =>
    location.pathname === to || location.pathname.startsWith(`${to}/`);

  return (
    <>
      <NavLink
        to="/configuration"
        end
        className={({ isActive: on }) =>
          "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium transition mb-1 " +
          (on
            ? "bg-accent/10 text-accent"
            : "text-content dark:text-mortar-100 hover:bg-surface dark:hover:bg-slate-800")
        }
      >
        <Settings2 size={15} />
        Configuration
      </NavLink>
      <div className="relative mb-2 px-0.5">
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && firstHit) {
              navigate(firstHit.to);
              setQ("");
            }
            if (e.key === "Escape") setQ("");
          }}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="input !pl-7 !py-1 !text-xs w-full"
        />
      </div>
      {query && filtered.length === 0 && (
        <p className="px-2.5 py-1 text-xs text-faint dark:text-slate-500">
          No setting matches “{query}”.
        </p>
      )}
      {filtered.map((g) => (
        <div key={g.id} className="mb-3">
          <NavLink
            to={`/configuration/s/${g.id}`}
            className="block px-2.5 pt-1.5 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-accent"
          >
            {g.label}
          </NavLink>
          <ul>
            {g.entries.map((e) => {
              const Icon = e.icon;
              return (
                <li key={e.to}>
                  <NavLink
                    to={e.to}
                    title={e.description}
                    className={
                      "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition " +
                      (isActive(e.to)
                        ? "bg-accent/10 text-accent font-medium"
                        : "text-content/80 dark:text-mortar-200 hover:bg-surface dark:hover:bg-slate-800")
                    }
                  >
                    <Icon size={14} className="shrink-0 opacity-70" />
                    <span className="truncate">{e.label}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The way BACK, on every settings page.
 *
 *  Only 6 of the 26 settings pages carried their own "← Configuration" link, so
 *  most were a one-way trip: you arrived from a section card and the only exit
 *  was the browser's back button, or the sidebar, which phones do not get.
 *  Rendering it in the layout means a page cannot ship without one.
 *
 *  It points at the SECTION you came from rather than the hub, because that is
 *  the list you were just reading. The section is derived from the registry, so
 *  a new destination gets a correct crumb with no per-page work. */
/** The content column for the route we are on, from the registry. Pages used to
 *  each set their own max-w + mx-auto: six different widths and both
 *  alignments, so moving between two settings shifted the layout sideways. */
function useConfigColumn(): string {
  const { pathname } = useLocation();
  const hit = CONFIG_DESTINATIONS.find(
    (d) => pathname === d.to || pathname.startsWith(`${d.to}/`),
  );
  return columnFor(hit?.width);
}

function ConfigCrumb() {
  const { pathname } = useLocation();
  const section = sectionForPath(pathname);
  const here = CONFIG_DESTINATIONS.find(
    (d) => pathname === d.to || pathname.startsWith(`${d.to}/`),
  );
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-xs text-faint dark:text-slate-500 mb-3"
    >
      <NavLink to="/configuration" className="inline-flex items-center gap-1 hover:text-accent">
        <ChevronLeft size={13} /> Configuration
      </NavLink>
      {section && (
        <>
          <span aria-hidden>›</span>
          <NavLink to={`/configuration/s/${section}`} className="hover:text-accent">
            {CONFIG_SECTIONS[section].label}
          </NavLink>
        </>
      )}
      {here && (
        <>
          <span aria-hidden>›</span>
          <span className="text-content/70 dark:text-mortar-200 truncate">{here.label}</span>
        </>
      )}
    </nav>
  );
}

/** Phone-sized jump control, so a phone can move between settings without
 *  returning to the hub for every hop. */
function MobileConfigJump() {
  const navigate = useNavigate();
  const location = useLocation();
  const ctx = useConfigVisibility();
  const { panels } = useHostedPanels();
  const all = visibleDestinations(ctx);
  return (
    <div className="md:hidden mb-4 flex items-center gap-2">
      <NavLink
        to="/configuration"
        className="shrink-0 inline-flex items-center gap-1 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ChevronLeft size={13} /> all
      </NavLink>
      <select
        aria-label="Jump to a setting"
        value={all.find((d) => location.pathname.startsWith(d.to))?.to ?? ""}
        onChange={(e) => e.target.value && navigate(e.target.value)}
        className="input !py-1 !text-xs flex-1 min-w-0"
      >
        <option value="">Jump to…</option>
        {CONFIG_SECTION_ORDER.map((id) => {
          const items = all.filter((d) => d.section === id);
          if (!items.length) return null;
          return (
            <optgroup key={id} label={CONFIG_SECTIONS[id].label}>
              {items.map((d) => (
                <option key={d.to} value={d.to}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          );
        })}
        {panels.length > 0 && (
          <optgroup label={HOSTED_SECTION.label}>
            {panels.map((p) => (
              <option key={p.id} value={`/configuration/x/${p.id}`}>
                {p.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

export function ConfigurationLayout() {
  const location = useLocation();
  const navMode = useNavMode();
  const column = useConfigColumn();
  // The hub and the section pages ARE navigation; a rail beside them would
  // just repeat the page.
  const onIndex =
    location.pathname === "/configuration" ||
    location.pathname.startsWith("/configuration/s/");

  if (navMode === "side") {
    return (
      <ConfigHeaderProvider>
        <div className={"min-w-0 " + column}>
          {!onIndex && <ConfigCrumb />}
          {!onIndex && <MobileConfigJump />}
          {!onIndex && <ConfigPageHeader />}
          <Outlet />
        </div>
      </ConfigHeaderProvider>
    );
  }
  if (onIndex) {
    return (
      <div className={"min-w-0 " + column}>
        <Outlet />
      </div>
    );
  }
  return (
    <ConfigHeaderProvider>
    <div className="md:grid md:grid-cols-[13.5rem_1fr] md:gap-6 md:items-start">
      <aside className="hidden md:block sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1">
        <ConfigSidebarBody />
      </aside>
      <div className={"min-w-0 " + column}>
        <ConfigCrumb />
        <MobileConfigJump />
        <ConfigPageHeader />
        <Outlet />
      </div>
    </div>
    </ConfigHeaderProvider>
  );
}
