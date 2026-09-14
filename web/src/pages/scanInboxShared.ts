// Facts about a scan inbox item that the page, its cards and its session
// chrome all read: how old it is, and the shape of a filing target. Pure;
// no React. Lives beside the page so the desktop card (ScanInboxCard) and
// the page can share them without one importing the other.
/** Compact relative time for an inbox item's last touch ("just now", "10 min
 *  ago", "3 h ago", "2 d ago") — so you can see how stale this listing is. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

/** True when the item never got a real identity — no name, or the AI's
 *  "couldn't identify it" placeholder ("Unknown Item"). Used to suppress the
 *  catalog photo search (searching "Unknown Item" returns junk) and the default
 *  commit target (don't pre-route an unidentified thing into Inventory). */

/** Where scans confirm into — a module instance (e.g. the "yarn" inventory
 *  instance), passed via the URL when you scan from an instance's table. */
export type ScanTarget = { instance: string; module: string; kind: string; label: string };
