// Every record detail panel, registered before any page renders: main.tsx
// imports this file first (#5954). A panel registered anywhere else did not
// exist until some page that imported it had loaded, so a module's own detail
// page opened first had no History, Links, Photos and files or Tags. The
// components stay lazy; only these lines are in the first load.
import { lazy } from "react";
import { registerDetailPanel } from "@cobblr/platform-web";

registerDetailPanel(
  "builds:board-revisions",
  lazy(() => import("../features/builds/boardRevisions").then(m => ({ default: m.BoardProjectPanel }))),
);

registerDetailPanel("digifab:kiln", lazy(() => import("../features/digifab/kiln").then(m => ({ default: m.KilnPanel }))));
registerDetailPanel("digifab:arm", lazy(() => import("../features/digifab/robotArm").then(m => ({ default: m.ArmPanel }))));
registerDetailPanel("digifab:care", lazy(() => import("../features/digifab/MachineCare").then(m => ({ default: m.MachineCarePanel }))));
registerDetailPanel("digifab:cell", lazy(() => import("../features/digifab/robotCell").then(m => ({ default: m.CellPanel }))));

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

registerDetailPanel(
  "inventory:stock-here",
  lazy(() => import("../features/inventory/stockHere").then((m) => ({ default: m.StockHerePanel }))),
);

registerDetailPanel(
  "inventory:when-it-runs-out",
  lazy(() => import("../features/inventory/whenItRunsOut").then((m) => ({ default: m.WhenItRunsOutPanel }))),
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

registerDetailPanel("digifab:instrument",lazy(()=>import("../features/digifab/bench").then(m=>({default:m.BenchPanel}))));
