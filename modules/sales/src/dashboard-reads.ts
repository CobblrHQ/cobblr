// What sales' dashboard tile reads (ui/DashboardWidget.tsx), named for the one-request
// dashboard snapshot (#6563): what the shop is owed, the same route the Sales page lists.
import { registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

export function registerSalesDashboardReads(): void {
  registerDashboardRead({
    id: "sales.owed",
    module: "sales",
    paths: ({ slug }) => [`/orgs/${slug}/modules/sales/orders/owed`],
  });
}
