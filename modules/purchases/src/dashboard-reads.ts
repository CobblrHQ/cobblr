// What purchases reads on the dashboard, named for the one-request dashboard
// snapshot (#6563): its tile's counts (web/src/dashboard/builtinWidgets.tsx),
// the orders a parcel on its way is read from, and the one-record probe.
import { registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

export function registerPurchasesDashboardReads(): void {
  registerDashboardRead({
    id: "purchases.tile",
    module: "purchases",
    paths: ({ slug }) => [`/orgs/${slug}/modules/purchases/orders/dashboard`, `/orgs/${slug}/modules/purchases/orders`, `/orgs/${slug}/modules/purchases/orders?limit=1`],
  });
}
