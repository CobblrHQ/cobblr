// The schema side of safe-href.ts: every link a schema takes is a web address
// (#9709), held there by the code:web-link capabilities row.
import { z } from "zod";
import { WEB_LINK, WEB_LINK_REFUSED } from "@cobblr/platform-contract/safe-href";

export { WEB_LINK_REFUSED };

/** The schema every stored or followed link is taken through: a URL whose
 *  scheme is http or https. A zod string still, so `.max()`, `.regex()`,
 *  `.nullable()` and `.optional()` chain as before. Pass a base to trim first:
 *  `webLink(z.string().trim())`. */
export function webLink(base: z.ZodString = z.string()): z.ZodString {
  return base.url(WEB_LINK_REFUSED).regex(WEB_LINK, WEB_LINK_REFUSED);
}
