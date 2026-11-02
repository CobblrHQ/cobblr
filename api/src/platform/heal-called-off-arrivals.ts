// One-shot heal: no inbox keeps the arrival of an offer an ended share called off.
//
// DONE WHEN: no workspace's scan inbox holds a waiting row that a withdrawn
// incoming offer landed as. Check with, on the platform database:
//   select count(*) from share_offers where direction = 'in' and status = 'withdrawn'
//    and landed is not null and decided_at < '2026-11-03T02:35:00Z';
// then, for each row's landed org and inbox id, whether that inbox row still
// waits. /healthz reports the count (noteHealShim, through registerHealPass).
// When it reads 0 on prod, app, try and staging, delete this file and its boot
// call.
//
// BORN WITH: nothing (a fresh workspace has no ended shares, and a share that
// ends from now on removes the arrival in callOffOpenOffers or as its landing
// is recorded, whichever comes second).
//
// WHY IT EXISTS: an arrival is in the inbox before its offer records where it
// landed (#7711). A share ended in that gap called the offer off, found no
// landing to clear, and left the arrival waiting for good: an offer nobody
// could answer (#9133).

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { healCalledOffArrivalsIn } from "./share-offers.js";

/** Call from boot. A registered pass: the kernel's walk and budget. */
export function registerCalledOffArrivalsHeal(): void {
  registerHealPass({
    name: "shares.heal-called-off-arrivals",
    since: "2026-11-03T02:35:00Z",
    shim: "api/src/platform/heal-called-off-arrivals.ts",
    visit: async ({ orgId, since }) => {
      const n = await healCalledOffArrivalsIn(orgId, since);
      if (n) console.log(`[shares] org ${orgId}: took ${n} arrival${n === 1 ? "" : "s"} of called-off offers out of the inbox`);
      return n;
    },
  });
}
