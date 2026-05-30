// Action handlers, registered at module load via api/index.ts's
// side-effect call.
//
// The autonomous photo-sort is a WIRE, not a cron baked into the
// module: a default binding fires core-scan:identify-photo on every
// core-scan.scan.received. Photo-only rows get vision-identified
// detached; the user can edit / disable the wire on /bindings like any
// other. (The barcode fast path stays inline in POST /scan — it needs
// the request's ~12s budget for responsiveness.)

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { enrichPhotoItem } from "../services/enrich-photo.js";

let registered = false;

export function registerScanHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-scan.identify-photo", async (ctx) => {
    const itemId = ctx.event?.payload?.itemId;
    if (typeof itemId !== "string" || !itemId) return { ok: true, skipped: "no item id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreScanDB>;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["barcode_text", "image_file_id", "ai_suggested_at"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!row) return { ok: true, skipped: "no such row" };
    // Only photo-only scans — a barcode is handled inline by the fast
    // path; an already-enriched row isn't re-run by the auto wire.
    if (row.barcode_text || !row.image_file_id || row.ai_suggested_at) {
      return { ok: true, skipped: "not an un-enriched photo-only scan" };
    }
    await enrichPhotoItem({ db, orgId: ctx.orgId, itemId, imageFileId: row.image_file_id });
    void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.orgId, itemId });
    return { ok: true, identified: true };
  });
}
