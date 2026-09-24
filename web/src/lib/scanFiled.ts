// A filing changed the inbox: every screen that shows it refreshes, whichever
// door filed.
//
// Each filing door used to refresh what its own button happened to know about.
// One-tap Add refreshed the pending list, so the item left the inbox, but
// Recently committed kept its old count and did not list it, and Send back
// was out of reach until a reload (#3607). The doors are many (Add, File N,
// File all, the dashboard's Add all, the put-away plan, the phone sheet) and
// the queries are many; a list per button is how one of them drifts.
//
// So the refresh hangs off the one place every filing passes through on the
// client: the api calls that file (confirmScanItem, autofileScan,
// materializeQuickstart, unconfirmScanItem) announce a filing on success,
// and one listener mounted once in the app invalidates every query a filing
// changes. A new door files through those calls and is covered; a new query
// that shows filed or pending rows either joins the inbox key family
// (scan-inbox-keys.ts) or belongs in SCAN_FILED_QUERIES.

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { scanInboxKeys } from "./scan-inbox-keys";

/** Every query a filing (or undoing one) changes. The inbox's own lists and
 *  counts are one key family (scan-inbox-keys.ts), refreshed by its root; the
 *  rest show filed or pending rows from their own angle and are keyed
 *  [prefix, slug, ...]. */
export const SCAN_FILED_QUERIES = [
  "scan-item-live",
  "scan-tracked",
  "scan-duplicates",
  "scan-receipt-groups",
  "scan-photo-wanted",
  "capture-inbox",
  "scanner-queue",
] as const;

const EVENT = "cobblr:scan-filed";
const bus = new EventTarget();

/** A filing succeeded in this workspace. */
export function announceScanFiled(slug: string): void {
  bus.dispatchEvent(new CustomEvent<string>(EVENT, { detail: slug }));
}

/** Invalidate every query a filing changes, for one workspace. */
export function refreshAfterFiling(qc: QueryClient, slug: string): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) }),
    ...SCAN_FILED_QUERIES.map((k) => qc.invalidateQueries({ queryKey: [k, slug] })),
  ]).then(() => undefined);
}

/** Mounted once, near the root: turns every announced filing into a refresh. */
export function useRefreshOnScanFiled(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const on = (e: Event) => {
      const slug = (e as CustomEvent<string>).detail;
      if (slug) void refreshAfterFiling(qc, slug);
    };
    bus.addEventListener(EVENT, on);
    return () => bus.removeEventListener(EVENT, on);
  }, [qc]);
}

/** The listener as a component, mounted once at the root beside the other
 *  workspace-wide refreshers. Renders nothing. */
export function ScanFiledRefresh(): null {
  useRefreshOnScanFiled();
  return null;
}
