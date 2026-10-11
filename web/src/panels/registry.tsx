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
import { ContributedDetailPanels, registerDetailPanel, registerViewToolbar, hasDetailPanel } from "@cobblr/platform-web";
import type { ConfigSectionCtx, ModulePageTabCtx } from "./types";

registerDetailPanel(
  "builds:board-revisions",
  lazy(() => import("../features/builds/boardRevisions").then(m => ({ default: m.BoardProjectPanel }))),
);

const PAGE_TABS: Record<string, LazyExoticComponent<ComponentType<{ ctx: ModulePageTabCtx }>>> = {
  "digifab:fleet-tab": lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.FleetPageTab }))),
};

registerDetailPanel("digifab:kiln", lazy(() => import("../features/digifab/kiln").then(m => ({ default: m.KilnPanel }))));
registerDetailPanel(
  "digifab:cockpit",
  lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.MachineCockpitPanel }))),
);
registerDetailPanel(
  "digifab:loaded",
  lazy(() => import("../features/digifab/loaded").then((m) => ({ default: m.LoadedSpoolsPanel }))),
);
registerDetailPanel(
  "digifab:printing-profile",
  lazy(() => import("../features/digifab/printingProfile").then((m) => ({ default: m.PrintingProfilePanel }))),
);
registerDetailPanel(
  "digifab:print-this",
  lazy(() => import("../features/digifab/printThis").then((m) => ({ default: m.PrintThisFilePanel }))),
);
registerDetailPanel(
  "inventory:material-cost",
  lazy(() => import("../features/inventory/materialCost").then((m) => ({ default: m.MaterialCostPanel }))),
);
registerViewToolbar(
  "inventory:stocktake-view",
  lazy(() => import("../features/inventory/stocktakeView").then((m) => ({ default: m.StocktakeViewControl }))),
);
registerDetailPanel(
  "inventory:stock-here",
  lazy(() => import("../features/inventory/stockHere").then((m) => ({ default: m.StockHerePanel }))),
);
registerDetailPanel(
  "purchases:price-history",
  lazy(() => import("../features/purchases/priceHistory").then((m) => ({ default: m.PriceHistoryPanel }))),
);
registerDetailPanel(
  "purchases:on-its-way",
  lazy(() => import("../features/purchases/onItsWay").then((m) => ({ default: m.OnItsWayPanel }))),
);
registerDetailPanel(
  "purchases:receipt-lines",
  lazy(() => import("../features/purchases/receiptLines").then((m) => ({ default: m.ReceiptLinesPanel }))),
);
// Universal side-cars (target "*"): every entity detail view that renders
// <ContributedDetailPanels> gets these, including module-owned pages that
// cannot import the web app's EntityAttachments.
//
// Registration order IS render order, and it matches EntityAttachments (tags,
// then discussion) so a record does not rearrange itself depending on which
// half of the app drew the page.
registerDetailPanel(
  "core-scan:suggested-photo",
  lazy(() => import("../features/core-scan/suggestedPhoto").then((m) => ({ default: m.SuggestedPhotoPanel }))),
);
registerDetailPanel(
  "core-tags:tags",
  lazy(() => import("../features/core-tags/panel").then((m) => ({ default: m.TagsPanel }))),
);
registerDetailPanel(
  "core-discussion:conversation",
  lazy(() => import("../features/core-discussion/panel").then((m) => ({ default: m.DiscussionPanel }))),
);
registerDetailPanel(
  "core-files:files",
  lazy(() => import("../features/core-files/panel").then((m) => ({ default: m.FilesPanel }))),
);
registerDetailPanel(
  "core-documents:documents",
  lazy(() => import("../features/core-documents/panel").then((m) => ({ default: m.DocumentsPanel }))),
);
// Links are the kernel's own (pairings), so platform-web declares this panel
// (KERNEL_PANELS) rather than a module.
registerDetailPanel(
  "platform:links",
  lazy(() => import("../features/links/panel").then((m) => ({ default: m.LinksPanel }))),
);
registerDetailPanel(
  "platform:vault-documents",
  lazy(() => import("../features/vault/RecordVaultDocuments").then((m) => ({ default: m.RecordVaultDocuments }))),
);
registerDetailPanel(
  "core-activity-log:history",
  lazy(() => import("../features/core-activity-log/history").then((m) => ({ default: m.HistoryPanel }))),
);
registerDetailPanel(
  "core-maintenance:renewals",
  lazy(() => import("../features/core-maintenance/renewals").then((m) => ({ default: m.MaintenanceRenewalsPanel }))),
);
registerDetailPanel(
  "core-maintenance:schedules",
  lazy(() => import("../features/core-maintenance/schedules").then((m) => ({ default: m.MaintenanceSchedulesPanel }))),
);
registerDetailPanel(
  "core-shipments:shipment",
  lazy(() => import("../features/core-shipments/shipment").then((m) => ({ default: m.ShipmentPanel }))),
);

registerDetailPanel(
  "core-devices:readings",
  lazy(() => import("../features/core-devices/readings").then(m => ({ default: m.ReadingsPanel }))),
);

// Sections on a kernel Configuration page (surface "configuration-section"):
// a module's own setting shown where its people look for it, without the
// page importing the module (lint:kernel-config-pages-name-no-module).
const CONFIG_SECTIONS: Record<string, LazyExoticComponent<ComponentType<{ ctx: ConfigSectionCtx }>>> = {
  "core-maintenance:reminder-default": lazy(() => import("../features/core-maintenance/reminderDefault").then((m) => ({ default: m.ReminderDefaultSection }))),
};

export const hasPageTab = (id: string): boolean => !!PAGE_TABS[id];
export const hasConfigSection = (id: string): boolean => !!CONFIG_SECTIONS[id];

/** Every section enabled modules contribute to this Configuration page, each
 *  in the page's own card. Nothing when none does. */
export function ContributedConfigSections({ target, panels, ctx }: { target: string; panels: ReadonlyArray<{ id: string; surface: string; target: string; title: string }>; ctx: ConfigSectionCtx }) {
  const mine = panels.filter((p) => p.surface === "configuration-section" && p.target === target && hasConfigSection(p.id));
  return (
    <>
      {mine.map((p) => {
        const Section = CONFIG_SECTIONS[p.id]!;
        return (
          <section key={p.id} data-config-section={p.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
            <h2 className="text-sm font-semibold text-content dark:text-mortar-100">{p.title}</h2>
            <Suspense fallback={<p className="text-sm text-faint">Loading…</p>}>
              <Section ctx={ctx} />
            </Suspense>
          </section>
        );
      })}
    </>
  );
}
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

registerDetailPanel("digifab:instrument",lazy(()=>import("../features/digifab/bench").then(m=>({default:m.BenchPanel}))));
