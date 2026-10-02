// One scanned item as a small square tile, in the dashboard's scanner lane.
// The photo IS the identifier for a scan: it is how a visitor knows the thing
// they just scanned is the thing on the screen.
//
// It LADDERS through candidate sources on failure (catalog file → catalog URL
// → own scan photo → initials), the ScanPage lesson: a cached catalog file or
// a hotlink-blocked URL must fall through, not go blank.
//
// And it never shows a white box. Until the image has actually painted, the
// tile shows the item's initials on the neutral chip every other thumbnail in
// the app uses (EntityThumb); the image sits on top and fades in on load. The
// blank square that motivated this (#3301): a lazily loaded <img> below the
// fold that WebKit had not started yet, so a row of product photos ended in a
// white hole where the book cover should have been, on the card whose whole
// job is to show the scan worked.
//
// Two halves, and they fix different things. The chip is the durable one: it
// stands between any unpainted image and a white square, whatever the reason
// the image is late (a lazy threshold, a slow network, a decode), on any
// engine, at any scroll position. Eager loading is the optimisation for the
// cause found here, cheap because there are a handful of these and each is a
// thumbnail the effect has already fetched to a blob. If eager ever costs
// something (a lane of many scans on a phone, decoding thumbnails nobody
// scrolls to), it may go back to lazy and the visible defect does not return;
// the chip is the part that must stay.

import { useEffect, useMemo, useState } from "react";
import { photoOrder } from "../lib/scanPhoto";

export interface CaptureTileItem {
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  image_file_id: string | null;
  suggested_name: string | null;
  suggested_candidates: Array<{ name: string }>;
  suggested_metadata?: unknown;
}

export function CaptureTile({ slug, it }: { slug: string; it: CaptureTileItem }) {
  // Order comes from the shared rule (unverified catalog art must not lead);
  // the fallback WALK past broken URLs stays here, since this tile advances an
  // index on each onError rather than keeping a broken-set.
  const candidates = useMemo(() => {
    const file = (id: string) => `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw?variant=thumb`;
    const byRole = {
      catalog: [it.catalog_image_file_id ? file(it.catalog_image_file_id) : null],
      yours: [it.image_file_id ? file(it.image_file_id) : null],
      frame: [],
    };
    return photoOrder(it).flatMap((r) => byRole[r]).filter((u): u is string => !!u);
  }, [slug, it]);
  const [idx, setIdx] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    setPainted(false);
    const url = candidates[idx];
    if (!url) { setSrc(null); return; }
    const internal = url.startsWith("/api/v1/");
    if (!internal) { setSrc(url); return; } // external → <img onError> advances
    let cancelled = false;
    let blobUrl: string | null = null;
    const token = localStorage.getItem("cobblr.token");
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => { if (cancelled) return; blobUrl = URL.createObjectURL(b); setSrc(blobUrl); })
      .catch(() => { if (!cancelled) setIdx((i) => i + 1); });
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [candidates, idx]);
  const name = it.suggested_candidates?.[0]?.name || it.suggested_name || "item";
  const initials = name.slice(0, 2);
  return (
    <div
      title={name}
      data-testid="capture-tile"
      data-painted={painted ? "yes" : "no"}
      className={
        "relative flex-1 min-w-14 max-w-24 aspect-square rounded-md border border-line dark:border-slate-700 overflow-hidden grid place-items-center " +
        (painted ? "bg-surface dark:bg-slate-900" : "bg-subtle dark:bg-slate-800")
      }
    >
      {/* The chip underneath: what the tile shows until the image paints, and
          what it keeps showing when every candidate has failed. */}
      {!painted && (
        <span className="text-[11px] font-medium text-faint dark:text-slate-500 uppercase" aria-hidden={!!src}>
          {initials}
        </span>
      )}
      {src && (
        // EXTERNAL-IMAGE-OK: `src` is already resolved by this tile's own effect, which
        // token-fetches internal paths to a blob: URL. It does not use useImageSrc because it
        // must WALK to the next candidate when one fails, which the shared hook does not do.
        <img
          src={src}
          alt={name}
          loading="eager"
          decoding="async"
          className={"absolute inset-0 m-auto max-w-full max-h-full object-contain transition-opacity duration-150 " + (painted ? "opacity-100" : "opacity-0")}
          onLoad={() => setPainted(true)}
          onError={() => { setSrc(null); setPainted(false); setIdx((i) => i + 1); }}
        />
      )}
    </div>
  );
}
