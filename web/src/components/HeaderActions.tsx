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
              "transition p-1.5 " +
              (isActive
                ? "text-cobble-600"
                : "text-slate-400 dark:text-slate-500 hover:text-cobble-600")
            }
          >
            <Icon size={16} />
          </NavLink>
        );
      })}
    </>
  );
}
