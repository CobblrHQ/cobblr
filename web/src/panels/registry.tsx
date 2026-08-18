// The panel registry — the web half of the `contributes.panels` seam
// (machines-digifab-unification.md §5). A module's manifest declares WHERE
// it contributes UI (gated on `operatesOn` at manifest validation); this
// registry says WHICH component renders for each declared panel id. Host
// pages query enabled modules' `panels` (from /orgs/:slug/modules), then
// render through ContributedPageTab / ContributedDetailPanels — no host ever
// imports a contributor's page, and lint-page-imports keeps it that way.
//
// DETAIL panels now live in platform-web's registry (registerDetailPanel), so
// a MODULE-owned detail page can host them too: inventory's part modal shows
// purchases' price history through exactly this seam, without inventory ever
// naming purchases. Page tabs remain a web-page concern and stay local.
//
// Adding a panel: declare it in the module manifest (contributes.panels),
// put the component in web/src/features/<module>/, and map its id here.
// An id declared in a manifest but missing here renders nothing (a typo is
// invisible, not a crash).

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { ContributedDetailPanels, registerDetailPanel, hasDetailPanel } from "@cobblr/platform-web";
import type { ModulePageTabCtx } from "./types";

const PAGE_TABS: Record<string, LazyExoticComponent<ComponentType<{ ctx: ModulePageTabCtx }>>> = {
  "digifab:fleet-tab": lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.FleetPageTab }))),
};

registerDetailPanel(
  "digifab:cockpit",
  lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.MachineCockpitPanel }))),
);
registerDetailPanel(
  "purchases:price-history",
  lazy(() => import("../features/purchases/priceHistory").then((m) => ({ default: m.PriceHistoryPanel }))),
);
registerDetailPanel(
  "purchases:receipt-lines",
  lazy(() => import("../features/purchases/receiptLines").then((m) => ({ default: m.ReceiptLinesPanel }))),
);
registerDetailPanel(
  "core-shipments:shipment",
  lazy(() => import("../features/core-shipments/shipment").then((m) => ({ default: m.ShipmentPanel }))),
);

export const hasPageTab = (id: string): boolean => !!PAGE_TABS[id];
export { hasDetailPanel, ContributedDetailPanels };

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
