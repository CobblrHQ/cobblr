// One-shot heal: an emailed session read before #5722 is named for its shop
// and knows its order number, read again from the email it kept.
//
// DONE WHEN: no tenant DB has a core_scan_batches row with origin 'email'
// whose vendor or label is a forwarding banner (isMailTitle), and none whose
// order_ref is null while its kept email states one. /healthz reports the
// count this pass found; when it reads 0 on prod, staging and dev, delete
// this file and its boot call. Nothing re-creates the shape: a read takes
// the shop from the forwarded "From:" line (forwardedSender) and never a
// banner line (isMailTitle).
//
// BORN WITH: enrichReceiptMeta's forwardedSender (#5722), which names the
// shop of a forward read today.
//
// WHY IT EXISTS: the owner's Kingroon session of Oct 11 was read before that
// rule, so its shop and title read "---------- Forwarded message" and it had
// no order number. A re-forward of the same email is matched by (shop, order
// number), found nothing, and made a second session of the same lines
// (#6004). The kept email still says both, so this reads them from it, with
// no model.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { forwardedSender, isMailTitle, receiptSessionLabel } from "./services/receipt-shared.js";
import { detectOrderRef } from "./services/receipt-text.js";

interface HealDB {
  core_scan_batches: { id: string; origin: string | null; vendor: string | null; label: string | null; order_ref: string | null; source_file_id: string | null; created_at: Date };
  core_scan_inbox_items: { id: string; scan_batch_id: string | null; suggested_metadata: unknown };
}

const BANNER_SQL = "^\\s*-{2,}\\s*(forwarded|original)\\s+message|^\\s*begin\\s+forwarded\\s+message|^\\s*(fwd?|fw)\\s*:";

/** What a kept email says its session is: the shop and the order number. */
export function forwardedIdentity(text: string): { vendor: string | null; orderRef: string | null } {
  return { vendor: forwardedSender(text), orderRef: detectOrderRef(text) };
}

/** Heal one workspace; answers how many sessions it renamed or numbered.
 *  `readText` reads a kept file's text, or null when it cannot. */
export async function healForwardedSessionsIn(db: Kysely<HealDB>, since: Date, readText: (fileId: string) => Promise<string | null>): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_batches")
    .select(["id", "vendor", "label", "order_ref", "source_file_id"])
    .where("created_at", "<", since)
    .where("origin", "=", "email")
    .where("source_file_id", "is not", null)
    .where((eb) =>
      eb.or([
        eb(sql<string>`coalesce(vendor, '')`, "~*", BANNER_SQL),
        eb(sql<string>`regexp_replace(coalesce(label, ''), '^Receipt\\s*·\\s*', '')`, "~*", BANNER_SQL),
        eb("order_ref", "is", null),
      ]),
    )
    .execute();
  let n = 0;
  for (const b of rows) {
    const text = await readText(b.source_file_id!);
    if (!text) continue;
    const said = forwardedIdentity(text);
    const badVendor = !b.vendor || isMailTitle(b.vendor);
    const vendor = badVendor ? said.vendor ?? b.vendor : b.vendor;
    const orderRef = b.order_ref ?? said.orderRef;
    if (vendor === b.vendor && orderRef === b.order_ref) continue;
    const labelBody = (b.label ?? "").replace(/^Receipt\s*·\s*/, "");
    const label = !b.label || isMailTitle(labelBody) || b.label === receiptSessionLabel(b.vendor, b.order_ref) ? receiptSessionLabel(vendor, orderRef) : b.label;
    await db.updateTable("core_scan_batches").set({ vendor, order_ref: orderRef, label }).where("id", "=", b.id).execute();
    // Each line says where it was bought from the same banner: it says the shop now.
    if (vendor && vendor !== b.vendor) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: sql`jsonb_set(coalesce(suggested_metadata, '{}'::jsonb), '{receipt_vendor}', to_jsonb(${vendor}::text))` as never })
        .where("scan_batch_id", "=", b.id)
        .where((eb) => eb.or([eb(sql`suggested_metadata->>'receipt_vendor'`, "is", null), eb(sql<string>`suggested_metadata->>'receipt_vendor'`, "~*", BANNER_SQL)]))
        .execute();
    }
    n++;
  }
  return n;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger, never a walk of its own at boot. */
export function registerForwardedSessionIdentityHeal(): void {
  registerHealPass({
    name: "core-scan.heal-forwarded-session-identity",
    since: "2026-10-12T16:27:16Z",
    shim: "modules/core-scan/src/heal-forwarded-session-identity.ts",
    module: "core-scan",
    visit: async ({ orgId, db, since }) => {
      const n = await healForwardedSessionsIn(db as Kysely<HealDB>, since, async (fileId) => {
        const f = await platform().files.read(orgId, fileId, "original").catch(() => null);
        return f ? new TextDecoder().decode(f.bytes) : null;
      });
      if (n > 0) console.log(`[core-scan] org ${orgId}: named ${n} emailed session(s) for their shop and order`);
      return n;
    },
  });
}
