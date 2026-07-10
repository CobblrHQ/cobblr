// The panel registry — the web half of the `contributes.panels` seam
// (machines-digifab-unification.md §5). A module's manifest declares WHERE
// it contributes UI (gated on `operatesOn` at manifest validation); this
// registry says WHICH component renders for each declared panel id. Host
// pages query enabled modules' `panels` (from /orgs/:slug/modules), then
// render through ContributedPageTab / ContributedDetailPanel — no host ever
// imports a contributor's page, and lint-page-imports keeps it that way.
//
// Adding a panel: declare it in the module manifest (contributes.panels),
// put the component in web/src/features/<module>/, and map its id here.
// An id declared in a manifest but missing here renders nothing (the host
// shows the tab only if hasPageTab(id) — a typo is invisible, not a crash).

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import type { ModulePageTabCtx, EntityDetailPanelCtx } from "./types";

const PAGE_TABS: Record<string, LazyExoticComponent<ComponentType<{ ctx: ModulePageTabCtx }>>> = {
  "digifab:fleet-tab": lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.FleetPageTab }))),
};

const DETAIL_PANELS: Record<string, LazyExoticComponent<ComponentType<{ ctx: EntityDetailPanelCtx }>>> = {
  "digifab:cockpit": lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.MachineCockpitPanel }))),
};

export const hasPageTab = (id: string): boolean => !!PAGE_TABS[id];
export const hasDetailPanel = (id: string): boolean => !!DETAIL_PANELS[id];

const spinner = (
  <div className="text-xs text-faint italic py-4" aria-busy="true">
    loading…
  </div>
);

export function ContributedPageTab({ id, ctx }: { id: string; ctx: ModulePageTabCtx }) {
  const C = PAGE_TABS[id];
  if (!C) return null;
  return (
    <Suspense fallback={spinner}>
      <C ctx={ctx} />
    </Suspense>
  );
}

export function ContributedDetailPanel({ id, ctx }: { id: string; ctx: EntityDetailPanelCtx }) {
  const C = DETAIL_PANELS[id];
  if (!C) return null;
  return (
    <Suspense fallback={spinner}>
      <C ctx={ctx} />
    </Suspense>
  );
}
