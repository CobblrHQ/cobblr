// The live number on a nav row.
//
// A door a module declares (manifest `nav`) can also say where its count
// lives (`nav.count: { path, field }`). This hook polls each declared path and
// hands every nav surface one map: row key → the number waiting there. The
// three navs (sidebar, top bar with its "more" fold, phone menu) all read it,
// so a count can never show on one surface and not another.
//
// Why the row and not the camera: the camera button opens the SCANNER, and a
// number on it reads as "this is the inbox". The number belongs on the door
// to the inbox, which is the Scan Inbox row (design review #2920, 2026-09-13).
// Before this the pending count lived only on the dashboard card and on the
// inbox page itself, so someone who scanned twelve things on a phone and sat
// down at a desk had no signal in the nav that anything was waiting.

import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** Where one nav row's number comes from. `key` is the row's nav key, the
 *  same token navDoorsOf gives the door, so the renderer looks the badge up
 *  by the top's `name`. */
export interface NavCount {
  key: string;
  module: string;
  path: string;
  field: string;
}

/** How often every open tab asks. The bell polls at the same rate; a queue a
 *  person is working down should read fresh within a scan or two. */
export const NAV_COUNT_POLL_MS = 15_000;

/** Every nav count of one workspace: what a write there invalidates. */
export const navCountKeys = {
  all: (slug: string) => ["nav-count", slug] as const,
  one: (slug: string, module: string, path: string) => ["nav-count", slug, module, path] as const,
};

/** The declared counts among the enabled modules, keyed by the row each one
 *  belongs on: the module's nav key (its route's first word), which is the
 *  name of its row whether that row is a primary door (the Scan Inbox) or the
 *  module's own (Labels). A module with no row on screen simply has no badge
 *  drawn. Labels used to say its queue in a second row of its own beside its
 *  nav row, "Labels" and "Labels (2 queued)" (#4374). Pure, so the rule is
 *  testable without a navbar. */
export function navCountsOf(
  enabled: ReadonlyArray<{
    name: string;
    enabled?: boolean;
    nav?: {
      label: string;
      route: string;
      primary?: boolean | null;
      count?: { path: string; field: string } | null;
    } | null;
  }>,
): NavCount[] {
  const out: NavCount[] = [];
  for (const m of enabled) {
    if (m.enabled === false || !m.nav?.count) continue;
    const key = m.nav.route.replace(/^\//, "").split("/")[0] || m.name;
    if (out.some((c) => c.key === key)) continue;
    out.push({ key, module: m.name, path: m.nav.count.path, field: m.nav.count.field });
  }
  return out;
}

/** The number at `field`, or 0 when the endpoint did not say one. Anything
 *  that is not a finite non-negative integer is 0: a nav pill must never show
 *  "NaN" or "-1" because a module changed its response shape. */
export function badgeValue(data: Record<string, unknown> | undefined, field: string): number {
  const raw = data?.[field];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Row key → the number waiting there (rows with nothing to say are absent). */
export function useNavBadges(activeSlug: string): Map<string, number> {
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const counts = navCountsOf((modules.data?.items ?? []).filter((m) => m.enabled));
  const results = useQueries({
    queries: counts.map((c) => ({
      queryKey: navCountKeys.one(activeSlug, c.module, c.path),
      queryFn: () => api.moduleNavCount(activeSlug, c.module, c.path),
      enabled: !!activeSlug,
      staleTime: NAV_COUNT_POLL_MS - 1_000,
      refetchInterval: NAV_COUNT_POLL_MS,
    })),
  });
  const badges = new Map<string, number>();
  counts.forEach((c, i) => {
    const n = badgeValue(results[i]?.data, c.field);
    if (n > 0) badges.set(c.key, n);
  });
  return badges;
}
