// Order emails filed before #5461: seal their store page links onto their
// orders and scrub the archive of the sign-in links they hold (one-shot, after
// the api is listening). Restored (#7679): 2026.8.1 archived those links in
// plain text and nothing else removes them.
import { bootPass } from "../boot-passes.js";
import { scheduleOrderPageLinkHeal } from "../heal-order-page-links.js";
import { handOrderPageLink } from "../../routes/receipt-ingest.js";

export default bootPass({
  name: "healOrderPageLinks",
  phase: "background",
  run: () => scheduleOrderPageLinkHeal(handOrderPageLink),
});
