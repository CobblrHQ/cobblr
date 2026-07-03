// Persistent shell for every /configuration/* page — a grouped sidebar (from
// the ONE registry in lib/configuration-nav.ts) beside the routed page, so
// moving between settings never bounces back through the hub. Part of the
// 2026-07 settings rework; the hub (/configuration) stays the searchable
// index, this is the orientation that was missing.
//
// Lives INSIDE AppLayout (unlike AdminLayout, which is its own top-level
// shell) — the workspace chrome stays; only the content column gains the
// sidebar. On small screens the sidebar hides: the hub already serves as
// mobile navigation, and a permanent rail would crowd a phone viewport.

import { useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, Settings2 } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { iconForName as iconForPanel } from "../lib/panel-icons";
import { useNavMode } from "../lib/nav-mode";
import {
  CONFIG_DESTINATIONS,
  CONFIG_GROUPS,
  CONFIG_GROUP_ORDER,
  LEGACY_GROUP_MAP,
  destinationMatches,
  type ConfigDestination,
} from "../lib/configuration-nav";

/** The configuration sidebar's CONTENT — hub link, settings search, grouped
 *  destinations (registry + hosted panels). Rendered in two hosts: this
 *  layout's own aside (top-nav mode) and the MAIN nav sidebar (side-nav mode
 *  folds it in via SidebarNav, so two sidebars never stack). */
export function ConfigSidebarBody() {
  const { activeSlug } = useActiveOrg();
  const location = useLocation();
  const navigate = useNavigate();
  // The registry search lives IN the sidebar (2026-07-03): it used to exist
  // only on the hub page, which the sidebar made a place you never revisit.
  // Filters label+description+synonyms; Enter jumps to the first hit.
  const [q, setQ] = useState("");

  const hostedPanelsQ = useQuery({
    queryKey: ["hosted-panels", activeSlug],
    queryFn: () =>
      api.request<{ panels: Array<{ id: string; label: string; icon?: string; group?: string }> }>(
        "GET",
        `/orgs/${activeSlug}/hosted-panels`,
      ),
    enabled: !!activeSlug,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const entries: ConfigDestination[] = [
    ...CONFIG_DESTINATIONS,
    ...(hostedPanelsQ.data?.panels ?? []).map((p) => ({
      label: p.label,
      description: "",
      icon: iconForPanel(p.icon),
      to: `/configuration/x/${p.id}`,
      group: LEGACY_GROUP_MAP[p.group ?? "extend"] ?? ("automation" as const),
    })),
  ];

  const target = (d: ConfigDestination): string =>
    d.to ?? `/configuration?open=${d.modal}`;
  const query = q.trim();
  const visible = useMemo(
    () => (query ? entries.filter((d) => destinationMatches(d, query)) : entries),
    // entries is rebuilt per render from a stable registry + a cached query —
    // keying the memo off the inputs that actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, hostedPanelsQ.data],
  );
  const isActive = (d: ConfigDestination): boolean =>
    !!d.to && (location.pathname === d.to || location.pathname.startsWith(`${d.to}/`));

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
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && visible[0]) {
                navigate(target(visible[0]));
                setQ("");
              }
              if (e.key === "Escape") setQ("");
            }}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="input !pl-7 !py-1 !text-xs w-full"
          />
        </div>
        {query && visible.length === 0 && (
          <p className="px-2.5 py-1 text-xs text-faint dark:text-slate-500">No setting matches “{query}”.</p>
        )}
        {CONFIG_GROUP_ORDER.map((g) => {
          const group = visible.filter((d) => d.group === g);
          if (group.length === 0) return null;
          return (
            <div key={g} className="mb-3">
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                {CONFIG_GROUPS[g].label}
              </div>
              <ul>
                {group.map((d) => {
                  const Icon = d.icon;
                  return (
                    <li key={d.label}>
                      <NavLink
                        to={target(d)}
                        title={d.description}
                        className={
                          "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition " +
                          (isActive(d)
                            ? "bg-accent/10 text-accent font-medium"
                            : "text-content/80 dark:text-mortar-200 hover:bg-surface dark:hover:bg-slate-800")
                        }
                      >
                        <Icon size={14} className="shrink-0 opacity-70" />
                        <span className="truncate">{d.label}</span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
    </>
  );
}

export function ConfigurationLayout() {
  // Side-nav mode: the MAIN sidebar shows the configuration panel (SidebarNav
  // folds ConfigSidebarBody in), so this layout renders content full-width —
  // one sidebar on screen, never two. Top-nav mode keeps its own aside.
  const navMode = useNavMode();
  if (navMode === "side") {
    return (
      <div className="min-w-0">
        <Outlet />
      </div>
    );
  }
  return (
    <div className="md:grid md:grid-cols-[13.5rem_1fr] md:gap-6 md:items-start">
      <aside className="hidden md:block sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1">
        <ConfigSidebarBody />
      </aside>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
