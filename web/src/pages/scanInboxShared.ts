// Facts about a scan inbox item that the page, its cards and its session
// chrome all read: the shape of a filing target. How old it is reads
// relativeTime from @cobblr/platform-web, the one voice for that. Pure;
// no React. Lives beside the page so the desktop card (ScanInboxCard) and
// the page can share them without one importing the other.

/** True when the item never got a real identity — no name, or the AI's
 *  "couldn't identify it" placeholder ("Unknown Item"). Used to suppress the
 *  catalog photo search (searching "Unknown Item" returns junk) and the default
 *  commit target (don't pre-route an unidentified thing into Inventory). */

/** Where scans confirm into — a module instance (e.g. the "yarn" inventory
 *  instance), passed via the URL when you scan from an instance's table. */
export type ScanTarget = { instance: string; module: string; kind: string; label: string };
