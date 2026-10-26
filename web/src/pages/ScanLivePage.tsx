// /scan/live — the last few scans, big, for a screen that is not the scanner.
//
// A ring scanner on a finger has nowhere to say what it just read, and holding
// up a phone to check defeats the point of wearing it. This is the screen you
// prop on the bench, open on a second monitor, or leave on a tablet: it shows
// what was just captured and where it is going, and it says so in type you can
// read from across a room.
//
// It is NOT a second inbox, and the difference is deliberate: nothing here is
// a control. No filing, no discard, no selection. A display somebody walks
// past must not be a place work can be lost by leaning on it.
//
// The cursor is the whole reason this is not "poll the inbox": a display that
// slept (a tab in the background, a tablet that dozed, a dropped connection)
// has to be able to tell "nothing has been scanned" from "I missed three", and
// the feed answers both in one read.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, ScanLine } from "lucide-react";
import { usePageTitle, EntityPhoto } from "@cobblr/platform-web";
import { api, type ScanInboxItem } from "../lib/api";
import { leadPhoto } from "../lib/scanPhoto";
import { leadYours, rowPictures, scanFileUrl } from "../lib/rowPictures";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useQuery } from "@tanstack/react-query";
import { useScanViewer } from "./scanViewer";
import { itemDestinationLabel } from "../lib/itemDestination";

/** How often the display asks. Two seconds is under the time it takes to move
 *  the scanner to the next thing, so the answer is on screen before the person
 *  looks up; it is also cheap, since a quiet read is one indexed query. */
const EVERY_MS = 2000;
/** How many the display keeps behind the big one. Enough to see a run of
 *  scans, few enough that the newest is never pushed off a small screen. */
const KEEP = 6;

/** What the row says it is, in the order a person reads: the name the pipeline
 *  found, else the code it read, else that it is still working on it. */
function titleOf(row: ScanInboxItem): string {
  return row.suggested_name?.trim() || row.barcode_text?.trim() || "Scanned";
}


function Thumb({ row, big, slug }: { row: ScanInboxItem; big?: boolean; slug: string }) {
  // The shared ladder, not an inline pick: which of the catalog art and the
  // person's own photo LEADS depends on the cross-check, and a display that
  // chose for itself would show catalog art for a row whose photo contradicts
  // it (lib/scanPhoto, lint:scan-photo-lead).
  const resolved = rowPictures(slug, row);
  const yours = leadYours(resolved.pictures);
  const src =
    leadPhoto(row, {
      catalog: [
        row.catalog_image_file_id ? scanFileUrl(slug, row.catalog_image_file_id) : null,
      ],
      yours: yours ? resolved.src(yours) : null,
    }).src;
  const size = big ? "h-36 w-36 sm:h-56 sm:w-56" : "h-12 w-12";
  return (
    <div className={`${size} relative shrink-0 overflow-hidden rounded-2xl`}>
      <EntityPhoto src={src} alt="" fill placeholder={<ScanLine size={big ? 48 : 18} className="text-faint" />} />
    </div>
  );
}

export function ScanLivePage() {
  const { activeSlug, activeOrg } = useActiveOrg();
  // The card's own viewer, so this strip names the same table the card does.
  const menuQ = useQuery({ queryKey: ["scan-menu", activeSlug], queryFn: () => api.scanMenu(activeSlug), enabled: !!activeSlug, staleTime: 60_000 });
  const viewer = useScanViewer(menuQ.data?.items ?? null);
  const destinationOf = (row: ScanInboxItem) => itemDestinationLabel(row, viewer);
  usePageTitle("Live scans");
  const [rows, setRows] = useState<ScanInboxItem[]>([]);
  const [missed, setMissed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    if (!activeSlug) return;
    let live = true;
    const tick = async (): Promise<void> => {
      // A hidden tab is a display nobody is looking at: skip the round rather
      // than poll a wall screen that has been asleep since yesterday. The
      // cursor is what makes catching up afterwards correct.
      if (document.visibilityState === "hidden") return;
      try {
        const r = await api.scanFeed(activeSlug, { after: cursor.current ?? undefined, limit: KEEP });
        if (!live) return;
        setError(null);
        setReady(true);
        cursor.current = r.cursor;
        setMissed(r.missed);
        if (r.scans.length) {
          setRows((prev) => {
            const byId = new Map(prev.map((p) => [p.id, p]));
            // A re-scan BUMPS its row rather than making a new one, so the same
            // id can arrive again: it moves to the front instead of appearing
            // twice.
            for (const s of r.scans) byId.delete(s.id);
            return [...r.scans, ...byId.values()].slice(0, KEEP);
          });
        }
      } catch (e) {
        // failure-copy: the feed request just threw; its own message wins when it has one.
        if (live) setError(e instanceof Error ? e.message : "could not reach the workspace");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), EVERY_MS);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeSlug]);

  const [newest, ...rest] = rows;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6" data-scan-live>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-content dark:text-mortar-100">Live scans</h1>
        <Link to="/scan" className="text-xs text-faint hover:text-accent">
          the inbox →
        </Link>
      </div>
      <p className="mt-1 text-xs text-faint">
        The last few things scanned into {activeOrg?.name ?? "this workspace"}. Nothing here is a control: file them from the inbox.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-amber-400 bg-amber-50 dark:bg-amber-900/25 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300" data-scan-live-error>
          Not reaching the workspace right now ({error}). Still trying.
        </p>
      )}

      {!newest ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-center" data-scan-live-empty>
          {ready ? <ScanLine size={40} className="text-faint" /> : <Loader2 size={40} className="text-faint animate-spin" />}
          <p className="text-base font-medium text-muted">{ready ? "Waiting for a scan" : "Catching up…"}</p>
          <p className="max-w-sm text-xs text-faint">
            Scan anything with a wireless scanner, a phone, or the camera, and it appears here within a couple of seconds.
          </p>
        </div>
      ) : (
        <>
          {/* STACKED on a phone. Side by side, a 160px photo left the catalog's
              own name about half the width, and "Stabilo Point 88 Fineliner
              Marker Pen 0.4mm 88/57 Azure 5 Pieces" wrapped to seven lines
              that pushed the destination off the first screen. The photo is
              the smaller fact here; the name is what somebody reads across a
              bench. */}
          <div className="mt-5 flex flex-col items-start gap-4 sm:flex-row sm:items-center rounded-2xl border border-line/70 dark:border-slate-700/70 p-4" data-scan-live-newest>
            <Thumb row={newest} big slug={activeSlug} />
            <div className="min-w-0">
              <p className="text-2xl sm:text-3xl font-semibold leading-tight text-content dark:text-mortar-100 break-words" data-scan-live-title>
                {titleOf(newest)}
              </p>
              {destinationOf(newest) && (
                <p className="mt-2 text-base text-muted" data-scan-live-destination>
                  → {destinationOf(newest)}
                </p>
              )}
              <p className="mt-1 text-xs text-faint">
                {newest.status === "resolved" ? "filed" : "waiting in the inbox"}
                {newest.barcode_text ? ` · ${newest.barcode_text}` : ""}
              </p>
            </div>
          </div>

          {missed > 0 && (
            <p className="mt-3 text-xs text-faint" data-scan-live-missed>
              {missed} more {missed === 1 ? "scan" : "scans"} happened than fit on this screen. They are all in the inbox.
            </p>
          )}

          {rest.length > 0 && (
            <ul className="mt-4 space-y-2" data-scan-live-recent>
              {rest.map((row) => (
                <li key={row.id} className="flex items-center gap-3 rounded-xl border border-line/50 dark:border-slate-800 px-3 py-2">
                  <Thumb row={row} slug={activeSlug} />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-content dark:text-mortar-100">{titleOf(row)}</p>
                    <p className="truncate text-[11px] text-faint">
                      {destinationOf(row) ?? (row.status === "resolved" ? "filed" : "waiting in the inbox")}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
