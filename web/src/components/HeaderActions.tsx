// Module-contributed quick-actions for the navbar's RIGHT cluster.
// Any enabled module that declares a `headerAction` in its manifest
// gets an icon-only button here — prime, always-visible placement for
// its single most-used action (e.g. core-scan's camera button, which a
// user hits constantly). Icon-only by design; the label is
// the tooltip + aria-label.

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, isFocused } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";
import { readNavActionsHidden } from "../lib/nav-order";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** A header action that leads to BUILDER chrome (the AI builder, the
 *  marketplace) — hidden in focused mode. NB: `/builds` (the Builds domain) is
 *  NOT a builder route, so match `/build` exactly, not as a prefix. */
function isBuilderRoute(route: string): boolean {
  return route === "/build" || route.startsWith("/build/") || route.startsWith("/bundles");
}

export function HeaderActions() {
  const { activeSlug, activeOrg } = useActiveOrg();
  // Builder chrome (the AI builder, the marketplace) is the platform. Focused
  // mode hides it; a locked managed app has no platform at all, so the same
  // rule holds there ("Build" sat in a Home app's header and bounced, 2026-09-02).
  const focused = isFocused(activeOrg) || !!activeOrg?.app_mode;
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });

  // Per-device hide set — re-read when the customize control changes it.
  const [hidden, setHidden] = useState<string[]>(() =>
    readNavActionsHidden(activeSlug),
  );
  useEffect(() => {
    setHidden(readNavActionsHidden(activeSlug));
    const reload = () => setHidden(readNavActionsHidden(activeSlug));
    window.addEventListener("cobblr:nav-order-changed", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("cobblr:nav-order-changed", reload);
      window.removeEventListener("storage", reload);
    };
  }, [activeSlug]);

  const hiddenSet = new Set(hidden);
  const actions = (modules.data?.items ?? []).filter(
    (m) =>
      m.enabled &&
      m.headerAction &&
      !hiddenSet.has(m.name) &&
      // Focused mode hides the builder header actions (the AI builder) but keeps
      // capability actions like Scan.
      !(focused && isBuilderRoute(m.headerAction.route)),
  );
  // No count badge on the camera action: it opens the SCANNER, and a badge
  // reads as "this is the inbox" (the author). Pending-count signals live on the
  // "Scan Inbox" nav entry's destinations (dashboard card + /scan itself).

  if (actions.length === 0) return null;

  return (
    <>
      {actions.map((m) => {
        const ha = m.headerAction!;
        const Icon = moduleIcon(ha.icon);
        return (
          <NavLink
            key={m.name}
            to={ha.route}
            title={ha.label}
            aria-label={ha.label}
            data-testid={`header-action-${m.name}`}
            className={({ isActive }) =>
              "relative transition p-1.5 flex items-center gap-1 " +
              (isActive
                ? "text-accent"
                : "text-faint dark:text-slate-500 hover:text-accent")
            }
          >
            <Icon size={16} />
            {/* Text label where there's room — the bare icon alone was the
                discoverability gap the author named. Phones keep icon-only. */}
            <span className="hidden md:inline text-xs">{ha.label}</span>
          </NavLink>
        );
      })}
    </>
  );
}
