// The desktop shows the sample barcode; the phone scans it; the desktop
// notices (#3789).
//
// A visitor at the booth paired their phone, pointed it at the cola on the
// screen, and the screen sat there unchanged: the scan had landed, but the
// page that asked for it never said so. Now the page that shows the sample
// watches for it, with the inbox query it already has (no new channel), a
// little faster while it waits, and the moment the phone's scan arrives the
// card says "Got it" and opens that item.
//
// Only a NEW sample row counts: a sample scanned before the page started
// watching is not the one it is waiting for.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ScanInboxItem } from "./api";
import { DEMO_BARCODE } from "./demo-barcode";

const sameCode = (a: string | null | undefined) => (a ?? "").replace(/^0+/, "") === DEMO_BARCODE.replace(/^0+/, "");

/** The first sample row that was not there when the watch began, or null. */
export function newSampleRow(rows: readonly ScanInboxItem[], before: ReadonlySet<string>): ScanInboxItem | null {
  return rows.find((r) => sameCode(r.barcode_text) && !before.has(r.id)) ?? null;
}

/** Watch for the phone's scan of the sample while `watching`. */
export function useSampleScanArrival(slug: string, watching: boolean): ScanInboxItem | null {
  const q = useQuery({
    queryKey: ["sample-scan-watch", slug],
    queryFn: () => api.listScanInbox(slug, { status: "pending", limit: 20 }),
    enabled: !!slug && watching,
    refetchInterval: watching ? 2_000 : false,
  });
  const before = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!watching) before.current = null;
  }, [watching]);
  const rows = q.data?.items ?? [];
  if (watching && q.data && before.current === null) {
    before.current = new Set(rows.filter((r) => sameCode(r.barcode_text)).map((r) => r.id));
    return null;
  }
  return watching && before.current ? newSampleRow(rows, before.current) : null;
}

/** Watch, and once the sample arrives follow it: a beat to read "Got it",
 *  then its inbox card opens (`go`). Returns the arrived row for the words. */
export function useFollowSample(slug: string, watching: boolean, go: (path: string) => void): ScanInboxItem | null {
  const arrived = useSampleScanArrival(slug, watching);
  // The caller's `go` is a fresh function every render, and a page that
  // re-renders every second (the pair code's countdown) would restart the
  // timer forever. So it is read from a ref, and the timer keys on the row.
  const goRef = useRef(go);
  goRef.current = go;
  const went = useRef<string | null>(null);
  const arrivedId = arrived?.id ?? null;
  useEffect(() => {
    if (!arrivedId || went.current === arrivedId) return;
    const t = setTimeout(() => {
      went.current = arrivedId;
      goRef.current(`/scan?item=${encodeURIComponent(arrivedId)}`);
    }, 1_500);
    return () => clearTimeout(t);
  }, [arrivedId]);
  return arrived;
}

/** "Got it: here's your Coca Cola." */
export const sampleArrivedWords = (row: ScanInboxItem) => `Got it: here's your ${row.suggested_name?.trim() || "sample"}.`;
