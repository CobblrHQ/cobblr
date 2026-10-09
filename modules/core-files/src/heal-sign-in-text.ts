// One-shot heal: receipt text files filed from an email's body before #5461
// can still hold a store's "View order" sign-in link in plain text, when the
// email's plain part was the longer one. Each such file is announced first
// (core-files.file.sign_in_found, carrying only its id, so Purchases reads it
// and seals the link onto its order before it is gone), then its text is
// rewritten in place without that link or anything else sign-in shaped.
//
// DONE WHEN: no workspace has an emailed-receipt text file without
// metadata.sign_in_checked; then delete this file and its boot call. A new
// file is born clean: the ingest takes the link out of the body before it is
// written (receipt-ingest.ts, withoutSignInLinks), so nothing makes new ones.
//
// BORN WITH: ingestReceiptEmail (the body is scrubbed before the receipt text file is written)

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { hasSignInLink, orderPageLinkInText, withoutSignInLinks } from "@cobblr/platform-contract/order-page-link";
import type { CoreFilesDB, FileVariants } from "./db.js";
import { readVariantBytes, rewriteOriginalBytes } from "./api/storage.js";

/** The name the email ingest gives the body it files. */
export const EMAILED_RECEIPT_TEXT = "emailed-receipt.txt";
export const SIGN_IN_FOUND = "core-files.file.sign_in_found";

/** Heal one workspace; answers how many files held a sign-in link. */
export async function healSignInTextIn(orgId: string, db: Kysely<CoreFilesDB>): Promise<number> {
  const rows = await db
    .selectFrom("core_files_files")
    .select(["id", "variants", "metadata"])
    .where("filename", "=", EMAILED_RECEIPT_TEXT)
    .where("deleted_at", "is", null)
    .where("same_as", "is", null)
    .where(sql<boolean>`not (metadata ? 'sign_in_checked')`)
    .limit(200)
    .execute();
  let found = 0;
  for (const r of rows) {
    const variants = r.variants as FileVariants;
    const bytes = await readVariantBytes(orgId, r.id, variants, "original");
    const text = bytes ? bytes.toString("utf8") : "";
    const checked = { ...((r.metadata as Record<string, unknown>) ?? {}), sign_in_checked: new Date().toISOString() };
    if (!text || !hasSignInLink(text)) {
      await db.updateTable("core_files_files").set({ metadata: checked }).where("id", "=", r.id).execute();
      continue;
    }
    found++;
    // Sealed first: Purchases' subscriber reads this file and keeps the link
    // on its order (awaited, so it runs before the bytes change).
    await platform().events.emit(SIGN_IN_FOUND, { orgId, fileId: r.id });
    const next = await rewriteOriginalBytes(orgId, r.id, variants, new TextEncoder().encode(withoutSignInLinks(text, orderPageLinkInText(text))));
    await db
      .updateTable("core_files_files")
      .set({ variants: next.variants, sha256: next.sha256, size_bytes: String(next.size), metadata: checked })
      .where("id", "=", r.id)
      .execute();
  }
  return found;
}

/** Call from onBoot: the kernel's walk, budget and stagger. */
export function registerSignInTextHeal(): void {
  registerHealPass({
    name: "core-files.heal-sign-in-text",
    shim: "modules/core-files/src/heal-sign-in-text.ts",
    module: "core-files",
    visit: ({ orgId, db }) => healSignInTextIn(orgId, db as Kysely<CoreFilesDB>),
  });
}
