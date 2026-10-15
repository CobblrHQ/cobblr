// What labels reads on the dashboard, named for the one-request dashboard
// snapshot (#6563): its tile's count (ui/DashboardWidget.tsx), and the label
// tray's queue and QR settings, which the page asks while it draws.
import { registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

export function registerLabelsDashboardReads(): void {
  registerDashboardRead({
    id: "labels.tile",
    module: "labels",
    paths: ({ slug }) => [`/orgs/${slug}/modules/labels/queue/count`, `/orgs/${slug}/modules/labels/queue`, `/orgs/${slug}/modules/labels/qr/settings`],
  });
}
