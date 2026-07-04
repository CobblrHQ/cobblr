// P2 — the replace-clock (consumption capture, time rung).
//
// For items that aren't consumed continuously but REPLACED as a unit on a
// clock: a furnace filter (every 90 days), a water filter, a printer nozzle.
// Zero-touch until due, then one tap. It rides core-recurrence's per-entity
// scanner (the same engine as assets' watering) — no new sweep, no new state
// table. A part with `metadata.replace_every_days` gets a synthesised daily-
// interval rule anchored at `metadata.last_replaced_at` (else created_at); when
// it comes due the scanner emits `inventory.part.replace-due`, which a bundle
// wires to the shopping list / a notification. The "Replaced" action (in
// action-handlers) resets the anchor + consumes a spare.

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

let registered = false;

export function registerReplaceClock(): void {
  if (registered) return;
  registered = true;

  platform().recurrence.registerScanner("inventory:part", async (orgId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    const rows = await db
      .selectFrom("inventory_parts")
      .select(["id", "name", "metadata", "created_at"])
      .execute();
    const out: Array<{ entityId: string; rrule: string; title: string; event: string }> = [];
    for (const r of rows) {
      const md = (r.metadata as Record<string, unknown> | null) ?? {};
      const rrule = replaceRrule(md, r.created_at as unknown);
      if (rrule) {
        out.push({ entityId: r.id, rrule, title: r.name, event: "inventory.part.replace-due" });
      }
    }
    return out;
  });
}

/** The replace rule for one part, or "" if it has no clock. A raw
 *  metadata.replace_rrule wins (power users); otherwise replace_every_days →
 *  a daily-interval rule anchored at last_replaced_at (else created_at). The
 *  explicit DTSTART keeps firing deterministic across scans. Mirrors assets'
 *  waterRrule — modules don't share code, so the pattern is duplicated. */
export function replaceRrule(md: Record<string, unknown>, createdAt: unknown): string {
  const raw = md.replace_rrule;
  if (typeof raw === "string" && raw.length > 0) return raw;
  const days = Number(md.replace_every_days);
  if (!Number.isFinite(days) || days < 1) return "";
  const anchor = icalDate(md.last_replaced_at) ?? icalDate(createdAt) ?? "20200101T000000Z";
  return `DTSTART:${anchor}\nRRULE:FREQ=DAILY;INTERVAL=${Math.floor(days)}`;
}

/** Coerce a date-ish value to an iCal UTC stamp (YYYYMMDDT000000Z), or null. */
export function icalDate(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T000000Z`;
}
