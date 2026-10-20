// One-time, idempotent: the order emails filed before #5461 still hold a
// KEEP UNTIL: a stable release has shipped with this file in it (it was restored for 2026.10.0, #7679); lint:heal-shims holds the deletion to that.
// store's "View order" sign-in link in plain text in the inbound archive, and
// their orders never learned it. Each such link is handed to Purchases (sealed,
// attached to its order by number, so the order's tracking follows the store's
// page from now on), then the archived text and html are scrubbed of it and of
// anything else shaped like a sign-in link.
// DONE WHEN: the pass finds 0 archived emails holding a sign-in link on prod,
// the hosted instance and staging after a release; then delete this file and its start call.
//
// BORN WITH: archiveInboundEmail (a new email is archived already scrubbed) and ingestReceiptEmail (its link is handed to Purchases as it arrives)
//
// Cheap when settled: one indexed-free text match over the archive, which
// matches nothing once every row is scrubbed. A link Purchases could not take
// for a reason that may pass (a 5xx, the api not answering yet) is left for
// the next run; one it refused (Purchases off in that workspace) is scrubbed
// anyway, because an open sign-in link is not worth keeping for a feature
// that is off.

import { sql } from "kysely";
import { findOrderPageLink, withoutSignInLinks } from "@cobblr/platform-contract/order-page-link";
import { meta } from "../db/meta.js";
import { runExclusive } from "./exclusive.js";
import { noteHealShim } from "./heal-shim-log.js";
import { notePassFailure } from "./pass-failures.js";

const SHIM = "api/src/platform/heal-order-page-links.ts";
const SIGN_IN_SQL = String.raw`(/_t/c/|/authenticate\?key=|/account/orders/[0-9a-f]{32})`;

export type HandLink = (input: { orgId: string; userId: string; link: string; orderNumber: string | null }) => Promise<{ ok: boolean; retry: boolean }>;

function orderNumberOf(subject: string | null): string | null {
  return /#\s?([A-Z0-9][A-Z0-9-]{2,})\b/i.exec(subject ?? "")?.[1] ?? null;
}

export async function healOrderPageLinks(hand: HandLink): Promise<{ found: number; sealed: number; scrubbed: number; failed: number }> {
  const rows = await meta
    .selectFrom("inbound_emails")
    .select(["id", "org_id", "user_id", "from_email", "subject", "text_body", "html_body"])
    .where((eb) => eb.or([sql<boolean>`coalesce(html_body, '') ~ ${SIGN_IN_SQL}`, sql<boolean>`coalesce(text_body, '') ~ ${SIGN_IN_SQL}`]))
    .orderBy("received_at", "desc")
    .limit(500)
    .execute();
  let sealed = 0;
  let scrubbed = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const link = findOrderPageLink(r.html_body, r.from_email);
      if (link && r.org_id && r.user_id) {
        const out = await hand({ orgId: r.org_id, userId: r.user_id, link: link.url, orderNumber: orderNumberOf(r.subject) });
        if (out.ok) sealed++;
        else if (out.retry) {
          failed++;
          continue;
        }
      }
      await meta
        .updateTable("inbound_emails")
        .set({
          text_body: r.text_body == null ? null : withoutSignInLinks(r.text_body, link),
          html_body: r.html_body == null ? null : withoutSignInLinks(r.html_body, link),
        })
        .where("id", "=", r.id)
        .execute();
      scrubbed++;
    } catch (err) {
      failed++;
      notePassFailure(SHIM, r.id, new Error(`archive row ${r.id}: ${(err as Error).name}`));
    }
  }
  await noteHealShim(SHIM, rows.length, failed);
  return { found: rows.length, sealed, scrubbed, failed };
}

/** Once, a minute after start-up: it calls Purchases over the api's own
 *  routes, so it waits for the api to be listening, and one process runs it. */
export function scheduleOrderPageLinkHeal(hand: HandLink): void {
  setTimeout(() => {
    // SKIP-IF-BUSY OK: one-shot; the process holding the lock runs it, and the next start-up finds what is left
    void runExclusive(SHIM, async () => {
      const out = await healOrderPageLinks(hand);
      if (out.found) console.log(`[cobblr-api] order page links: ${out.sealed} sealed, ${out.scrubbed} archived emails scrubbed, ${out.failed} left for next time`);
    }).catch((err: unknown) => notePassFailure(SHIM, null, err));
  }, 60_000).unref?.();
}
