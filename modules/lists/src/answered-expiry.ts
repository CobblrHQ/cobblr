// An expiry reminder asks of each food: used up, or thrown out? Once the food
// is gone the question is answered, whichever door answered it: the reminder's
// own button, the record, a scan. Whether it is gone is the record's to say,
// read when the inbox is read, so a reload, another tab and the Groceries page
// agree, and a food with nothing left is not asked about again (#7931).

import { platform, SYSTEM_VIEWER } from "@cobblr/platform-contract";

/** How a food's stock answers the reminder, or null while some is left. */
export function answerOfStock(record: { fields?: Record<string, unknown> } | null | undefined): { label: string; at: string | null } | null {
  if (!record) return { label: "No longer in stock", at: null };
  const qty = Number(record.fields?.qty);
  return Number.isFinite(qty) && qty <= 0 ? { label: "None left", at: null } : null;
}

export function registerAnsweredExpiry(): void {
  platform().notifications.registerActionSettlement(["inventory:use-up", "inventory:mark-spoiled"], async (orgId, args) =>
    Promise.all(args.map(async (a) => {
      const id = typeof a.partId === "string" ? a.partId : "";
      if (!id) return null;
      // SYSTEM-READ: whether stock is gone does not depend on who is reading the inbox.
      const record = await platform().entities.lookup(orgId, "inventory:part", id, SYSTEM_VIEWER).catch(() => null);
      return answerOfStock(record);
    })),
  );
}
