// What the scan inbox shows on the dashboard (the scanner band, the put-away
// card, the inbox section), named for the one-request dashboard snapshot (#6563).
import { registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

export function registerScanDashboardReads(): void {
  registerDashboardRead({
    id: "core-scan.inbox",
    module: "core-scan",
    paths: ({ slug }) => [
      `/orgs/${slug}/modules/core-scan/inbox/stats`,
      `/orgs/${slug}/modules/core-scan/inbox/scanner-queue`,
      `/orgs/${slug}/modules/core-scan/inbox/receipt-groups/pending`,
      `/orgs/${slug}/modules/core-scan/inbox?status=pending`,
    ],
  });
}
