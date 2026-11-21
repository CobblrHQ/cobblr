// One-shot heal pass that only counts: links saved before every link field
// took only a web address (#9709), in an order's link and a vendor's
// website (purchases_orders.url, purchases_vendors.website).
//
// DONE WHEN: no tenant DB holds such a link that is not http or https. Check
// with, per tenant:
//   select count(*) from purchases_orders where url !~* '^https?://' and url <> '';
//   select count(*) from purchases_vendors where website !~* '^https?://' and website <> '';
// /healthz reports the count (noteHealShim, through registerHealPass). When it
// reads 0 on prod, app, try and staging, delete this file and its onBoot call.
//
// BORN WITH: the schemas take a link through webLink (http and https only),
// so a link saved now is a web address.
//
// WHY IT ONLY COUNTS: the link is the person's own data, so it is neither
// rewritten nor deleted; every page shows it through safeHref, as text rather
// than a link that runs script, until they change it.

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { nonWebLinkCount } from "@cobblr/platform-contract/non-web-links";
import type { Kysely } from "kysely";

const LINKS: ReadonlyArray<readonly [table: string, column: string]> = [["purchases_orders", "url"], ["purchases_vendors", "website"]];

export function registerPurchasesNonWebLinksCount(): void {
  registerHealPass({
    name: "purchases.count-non-web-links",
    since: "2026-11-21T00:00:00Z",
    shim: "modules/purchases/src/count-non-web-links.ts",
    module: "purchases",
    // Found and left: settled, so the workspace is not reopened every round.
    visit: async ({ db, since }) => {
      let found = 0;
      for (const [table, column] of LINKS) found += await nonWebLinkCount(db as Kysely<never>, table, column, since);
      return { found, settled: true };
    },
  });
}
