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

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { iconForName as iconForPanel } from "../lib/panel-icons";
import {
  CONFIG_DESTINATIONS,
  CONFIG_GROUPS,
  CONFIG_GROUP_ORDER,
  LEGACY_GROUP_MAP,
  type ConfigDestination,
} from "../lib/configuration-nav";

export function ConfigurationLayout() {
  const { activeSlug } = useActiveOrg();
  const location = useLocation();

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
  const isActive = (d: ConfigDestination): boolean =>
    !!d.to && (location.pathname === d.to || location.pathname.startsWith(`${d.to}/`));

  return (
    <div className="md:grid md:grid-cols-[13.5rem_1fr] md:gap-6 md:items-start">
      <aside className="hidden md:block sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1">
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
        {CONFIG_GROUP_ORDER.map((g) => {
          const group = entries.filter((d) => d.group === g);
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
      </aside>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
