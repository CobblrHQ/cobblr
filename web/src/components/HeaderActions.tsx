import type { ReactNode } from "react";
// Module-contributed quick-actions for the navbar's RIGHT cluster.
// Any enabled module that declares a `headerAction` in its manifest
// gets an icon-only button here — prime, always-visible placement for
// its single most-used action (e.g. core-scan's camera button, which a
// user hits constantly). Icon-only by design; the label is
// the tooltip + aria-label.

import { Fragment, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, isFocused } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";
import { readNavActionsHidden } from "../lib/nav-order";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

/** A header action that leads to BUILDER chrome (the AI builder, the
 *  marketplace) — hidden in focused mode. NB: `/builds` (the Builds domain) is
 *  NOT a builder route, so match `/build` exactly, not as a prefix. */
function isBuilderRoute(route: string): boolean {
  return route === "/build" || route.startsWith("/build/") || route.startsWith("/bundles");
}

/** The order the actions render in.
 *
 *  In the top bar they keep the order the workspace lists its modules in. As
 *  sidebar rows, CAPTURE comes first: Scan is the action a person reaches for
 *  many times a day and Build a few times a month, and the row under the nav
 *  is the one the eye lands on. Stable within each half, so two capability
 *  actions keep their listed order. Pure, so the sidebar's order is a fact a
 *  test can hold without rendering the layout. */
export function orderHeaderActions<T extends { headerAction: { route: string } | null }>(
  actions: readonly T[],
  capabilitiesFirst: boolean,
): T[] {
  if (!capabilitiesFirst) return [...actions];
  const isBuilder = (a: T) => !!a.headerAction && isBuilderRoute(a.headerAction.route);
  return [...actions.filter((a) => !isBuilder(a)), ...actions.filter(isBuilder)];
}

/** Actions that share one sidebar row, left to right. Scan and Build are the
 *  foot's two capture tools; a row each cost a line of a short column, the
 *  way Ask Cobb | Discussion would if it were split. Scan stays on the left:
 *  the first thing under the nav is the one the eye lands on, which is why
 *  the pair was once split when Build led it. */
export const SHARED_FOOT_ROWS: readonly (readonly string[])[] = [["core-scan", "core-authoring"]];

/** The sidebar rows the actions render as: each action on its own row, except
 *  a SHARED_FOOT_ROWS pair whose members are all present, which takes the row
 *  where its first member stands. Pure, so "Scan and Build share a line" is a
 *  fact a test holds without rendering the layout. */
export function footActionRows<T extends { name: string }>(actions: readonly T[]): T[][] {
  const rows: T[][] = [];
  const placed = new Set<string>();
  for (const a of actions) {
    if (placed.has(a.name)) continue;
    const pair = SHARED_FOOT_ROWS.find((r) => r.includes(a.name));
    const members = pair ? pair.map((n) => actions.find((x) => x.name === n)) : [];
    if (pair && members.every((m): m is T => !!m)) {
      for (const m of members) placed.add(m.name);
      rows.push(members);
    } else {
      placed.add(a.name);
      rows.push([a]);
    }
  }
  return rows;
}

export function HeaderActions({ asRows = false, trailing }: {
  /** Full-width labelled rows for the sidebar foot (capture first), instead
   *  of the top bar's icon buttons. */
  asRows?: boolean;
  /** Rows mode: a control that closes the FIRST row (Search's icon, so the
   *  foot reads Scan | Build | 🔍 rather than spending a row of its own on
   *  Search, #4374). `alone` is true when there is no action to share a row
   *  with, and the control then takes the row itself, labelled. */
  trailing?: (alone: boolean) => ReactNode;
} = {}) {
  const { activeSlug, activeOrg } = useActiveOrg();
  // Builder chrome (the AI builder, the marketplace) is the platform. Focused
  // mode hides it; a locked managed app has no platform at all, so the same
  // rule holds there ("Build" sat in a Home app's header and bounced, 2026-09-02).
  // And it is the admin tier's: a member now walks the workspace (#3122) but
  // installing and building are structure, not content.
  const focused = isFocused(activeOrg) || !!activeOrg?.app_mode || !roleSatisfies(activeOrg?.role, ["owner", "admin"]);
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
  const actions = orderHeaderActions(
    (modules.data?.items ?? []).filter(
      (m) =>
        m.enabled &&
        m.headerAction &&
        !hiddenSet.has(m.name) &&
        // Focused mode hides the builder header actions (the AI builder) but keeps
        // capability actions like Scan.
        !(focused && isBuilderRoute(m.headerAction.route)),
    ),
    asRows,
  );
  // No count badge on the camera action: it opens the SCANNER, and a badge
  // reads as "this is the inbox" (the author). The pending count rides the
  // "Scan Inbox" nav row itself (useNavBadges), the door to the inbox.

  if (actions.length === 0) return asRows && trailing ? <>{trailing(true)}</> : null;

  const link = (m: (typeof actions)[number], inRow: "full" | "half" | "bar") => {
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
          inRow === "bar"
            ? "relative transition p-[6px] flex items-center gap-1 " +
              (isActive ? "text-accent" : "text-faint dark:text-slate-500 hover:text-accent")
            : (inRow === "full" ? "w-full px-3 py-1.5 rounded " : "") +
              "flex items-center gap-2.5 whitespace-nowrap text-[13px] transition " +
              (isActive
                ? "text-accent font-semibold" + (inRow === "full" ? " bg-subtle/60 dark:bg-slate-800/40" : "")
                : "text-muted dark:text-slate-400 hover:text-accent" +
                  (inRow === "full" ? " hover:bg-subtle/60 dark:hover:bg-slate-800/40" : ""))
        }
      >
        <Icon size={16} className={inRow === "bar" ? undefined : "shrink-0"} />
        {/* Text label where there's room — the bare icon alone was the
            discoverability gap the author named. Phones keep icon-only;
            a sidebar row is always labelled. From lg: a phone on its side
            (852 px less its side insets) has no room for the words, and the
            nav beside them was cut in half (#6782). */}
        <span className={inRow === "bar" ? "hidden lg:inline text-xs" : ""}>{ha.label}</span>
      </NavLink>
    );
  };

  if (!asRows) return <>{actions.map((m) => link(m, "bar"))}</>;

  const end = (i: number) => (i === 0 && trailing ? trailing(false) : null);
  const bar = (
    <span aria-hidden className="text-[13px] text-faint/60 dark:text-slate-600 select-none">
      |
    </span>
  );
  // A shared row spaces its doors and the quiet bars between them evenly, so
  // Scan | Build | search reads as three equals at any sidebar width.
  // The search icon used to end the row after the text, packed against the
  // column's right edge (the owner, 2026-10-01, #4514).
  return (
    <>
      {footActionRows(actions).map((row, ri) => {
        const doors: ReactNode[] = row.map((m) => link(m, "half"));
        const tail = end(ri);
        if (tail) doors.push(tail);
        if (doors.length === 1) return link(row[0]!, "full");
        return (
          <div
            key={row.map((m) => m.name).join("+")}
            data-testid="foot-shared-row"
            className="w-full flex items-center justify-evenly py-1.5 rounded hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
          >
            {doors.map((d, i) => (
              <Fragment key={i}>
                {i > 0 && bar}
                <span data-foot-slot className="flex min-w-0 justify-center">
                  {d}
                </span>
              </Fragment>
            ))}
          </div>
        );
      })}
    </>
  );
}
