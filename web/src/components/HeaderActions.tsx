// Module-contributed quick-actions for the navbar's RIGHT cluster.
// Any enabled module that declares a `headerAction` in its manifest
// gets an icon-only button here — prime, always-visible placement for
// its single most-used action (e.g. core-scan's camera button, which a
// companion app user hits constantly). Icon-only by design; the label is
// the tooltip + aria-label.

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";
import { readNavActionsHidden } from "../lib/nav-order";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function HeaderActions() {
  const { activeSlug } = useActiveOrg();
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
    (m) => m.enabled && m.headerAction && !hiddenSet.has(m.name),
  );
  const scanOn = actions.some((m) => m.name === "core-scan");

  // The scan inbox is otherwise invisible (no nav noun) — a count badge on
  // its header icon is what makes "you have things waiting to be filed"
  // discoverable. Poll while the action is shown.
  const scanInbox = useQuery({
    queryKey: ["scan-inbox", activeSlug, "pending"],
    queryFn: () => api.listScanInbox(activeSlug, { status: "pending" }),
    enabled: !!activeSlug && scanOn,
    refetchInterval: 30_000,
  });
  const scanPending = scanInbox.data?.items.length ?? 0;

  if (actions.length === 0) return null;

  return (
    <>
      {actions.map((m) => {
        const ha = m.headerAction!;
        const Icon = moduleIcon(ha.icon);
        const badge = m.name === "core-scan" && scanPending > 0 ? scanPending : null;
        return (
          <NavLink
            key={m.name}
            to={ha.route}
            title={badge ? `${ha.label} — ${badge} pending` : ha.label}
            aria-label={badge ? `${ha.label}, ${badge} pending` : ha.label}
            data-testid={`header-action-${m.name}`}
            className={({ isActive }) =>
              "relative transition p-1.5 " +
              (isActive
                ? "text-accent"
                : "text-faint dark:text-slate-500 hover:text-accent")
            }
          >
            <Icon size={16} />
            {badge !== null && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-cobble-600 text-white text-[9px] font-semibold leading-[15px] text-center">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </NavLink>
        );
      })}
    </>
  );
}
