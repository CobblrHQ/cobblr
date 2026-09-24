// The scanner queue: every pending scan, grouped by where it could go, counted
// over the WHOLE inbox.
//
// The dashboard used to group the first page of the inbox (50 rows) and show
// that as the queue: "Waiting to file (50)" with 78 pending, "Add all 44" that
// filed the 44 on the page, and a put-away card that subtracted the page's
// offers from the server's total, "33 without a home" beside the inbox's 77
// (#3598). A count a person reads is the server's, over every row, and a bulk
// action acts on the ids the same answer names, never on the length of
// whatever page the browser happened to load.

import type { ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import { filingDestination, type DestinationRow } from "./destination.js";
import type { LiveTable } from "./resolve-offers.js";

export type QueueRow = DestinationRow & { id: string; source_kind: string | null };

export interface ScannerQueueGroup {
  key: string;
  label: string;
  /** A bundle not installed yet (Create & file). */
  bundle_external_id?: string;
  /** A table that exists (Add all N to). */
  target?: { module: string; kind: string; instance?: string };
  /** Every pending scan in the group, newest first: the set its action files. */
  item_ids: string[];
}

export interface ScannerQueue {
  /** Every pending scan that came from the scanner (not typed). */
  scanned_total: number;
  /** Scans with a home to offer, grouped by it, biggest first. */
  groups: ScannerQueueGroup[];
  /** Scans nothing here can place: unmatched, or still being read. */
  residual: number;
  /** The scans the groups account for (what the put-away card leaves out). */
  offered: number;
}

/** Group every pending scan by where it goes: the ONE destination the card
 *  shows (services/destination.ts), never the raw top candidate. Grouped by
 *  the raw route, a vinegar the card sent to Groceries sat in the Inventory
 *  group, and "Add all 54 to Inventory" filed it there (#3618). Typed
 *  captures (notes) are the panel's conversation, not this queue. */
export function scannerQueue(rows: readonly QueueRow[], tables: readonly ScanResolverTable[] = [], liveNow?: readonly LiveTable[]): ScannerQueue {
  const scanned = rows.filter((r) => r.source_kind !== "note");
  const map = new Map<string, ScannerQueueGroup>();
  let residual = 0;
  for (const r of scanned) {
    const c = filingDestination(r, tables, liveNow);
    if (!c || (!c.bundle_external_id && !(c.module && c.kind))) {
      residual++;
      continue;
    }
    const key = c.bundle_external_id ? `b:${c.bundle_external_id}` : `i:${c.module}:${c.instance ?? ""}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: c.label ?? c.module ?? "a table",
        ...(c.bundle_external_id ? { bundle_external_id: c.bundle_external_id } : { target: { module: c.module!, kind: c.kind!, ...(c.instance ? { instance: c.instance } : {}) } }),
        item_ids: [],
      };
      map.set(key, g);
    }
    g.item_ids.push(r.id);
  }
  const groups = [...map.values()].sort((a, b) => b.item_ids.length - a.item_ids.length);
  return { scanned_total: scanned.length, groups, residual, offered: groups.reduce((n, g) => n + g.item_ids.length, 0) };
}
