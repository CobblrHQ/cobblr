// Polar Filament — spool QR resolver via the official pfil.us data API.
//
// Polar prints a QR on every spool that encodes `3dqr.co/?i=<id>-<checksum>`
// (a redirect). The structured spool data lives at Polar's own JSON API,
// https://pfil.us/query_spool.php (given to us directly by Polar). We pull the
// spool id+checksum out of the scanned URL and query that API — clean JSON
// including nozzle/bed temps, which the public redirect page never exposed.
//
// Polar asks callers to (1) send a contact email and (2) cache results. We do
// both: POLAR_QUERY_EMAIL (env; defaults to Cobblr's contact) identifies us,
// and every resolution is cached cross-tenant by spool ref — a spool's data is
// immutable, so any given spool hits their server at most once, ever.

import { platform } from "@cobblr/platform-contract";
import type { ScanUrlResolver, ScanUrlResolution } from "@cobblr/platform-contract";

const QUERY_URL = "https://pfil.us/query_spool.php";
const API_VERSION = "1.00";
const CONTACT_EMAIL = process.env.POLAR_QUERY_EMAIL || "contact@example.com";
// Cache the MAPPED resolution by spool ref (a spool's data is immutable). The
// version suffix is bumped whenever polarSpoolToResolution's field mapping
// changes, so old entries (e.g. pre-pfil.us resolutions that lacked spool
// size / batch / temps) are abandoned and the spool is re-resolved fresh —
// otherwise a re-run keeps returning the stale shape and the form stays empty.
const CACHE_NS = "polar-spool-pfil-v2";

/** The QR encodes `…?i=<id>-<checksum>` (e.g. `52435-20V0`). Pull that token
 *  out of a 3dqr.co or pfil.us URL. */
function spoolRefFromUrl(value: string): string | null {
  const m = value.match(/[?&]i=([0-9]+-[A-Za-z0-9]+)/);
  return m?.[1] ?? null;
}

function matchesPolar(value: string): boolean {
  const v = value.trim();
  return /(?:3dqr\.co|pfil\.us)/i.test(v) && spoolRefFromUrl(v) != null;
}

/** The pfil.us `spool` object (the fields we map). */
export interface PolarSpoolData {
  id?: number;
  checksum?: string;
  color?: string;
  material_name?: string;
  diameter?: number;
  mass_grams?: number;
  nozzle_temp?: number;
  bed_temp?: number;
  brand_name?: string;
  sku?: string;
}

/** Map the API's spool object onto a ScanUrlResolution. Pure + tolerant —
 *  returns null if the essential identity (material/colour) is missing.
 *  Exported for the smoke test. material/color/diameter/temps land on the
 *  filament TYPE via the auto-lift; size/batch_code stay on the spool. */
export function polarSpoolToResolution(spool: PolarSpoolData): ScanUrlResolution | null {
  const material = spool.material_name?.trim() || null;
  const color = spool.color?.trim() || null;
  if (!material && !color) return null;
  const name = [color, material].filter(Boolean).join(" ") || "Filament";
  const sizeKg = typeof spool.mass_grams === "number" ? spool.mass_grams / 1000 : null;
  return {
    source: "polar-pfil",
    name,
    brand: spool.brand_name?.trim() || "Polar Filament",
    category: "filament",
    entityType: "part",
    fields: {
      material,
      color,
      diameter: typeof spool.diameter === "number" ? `${spool.diameter} mm` : null,
      size: sizeKg != null ? `${sizeKg} kg` : null,
      // The spool serial doubles as the maker's batch/lot code.
      batch_code: spool.id != null ? String(spool.id) : null,
      // From the official API — the public redirect page never had these.
      nozzle_temp: typeof spool.nozzle_temp === "number" ? spool.nozzle_temp : null,
      bed_temp: typeof spool.bed_temp === "number" ? spool.bed_temp : null,
    },
  };
}

async function resolvePolar(
  value: string,
  opts?: { force?: boolean },
): Promise<ScanUrlResolution | null> {
  const ref = spoolRefFromUrl(value.trim());
  if (!ref) return null;

  // Cache cross-tenant by spool ref (immutable per spool) — Polar asks callers
  // to cache; each spool's data never changes, so query them at most once. A
  // user-initiated re-run (`force`) SKIPS the read so the spool is re-fetched +
  // re-mapped (still re-cached below, healing a stale entry — e.g. after a
  // field-mapping change).
  if (!opts?.force) {
    const cached = await platform()
      .sharedCache.get<ScanUrlResolution>(CACHE_NS, ref)
      .catch(() => null);
    if (cached) return cached;
  }

  const url = `${QUERY_URL}?i=${encodeURIComponent(ref)}&email=${encodeURIComponent(
    CONTACT_EMAIL,
  )}&version=${API_VERSION}`;
  const res = await fetch(url, {
    headers: { "user-agent": "CobblrScan/1.0 (+https://cobblr.me)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { status?: string; spool?: PolarSpoolData };
  if (json.status !== "OK" || !json.spool) return null;
  const resolution = polarSpoolToResolution(json.spool);
  if (resolution) {
    await platform().sharedCache.put(CACHE_NS, ref, resolution).catch(() => {});
  }
  return resolution;
}

export const polarResolver: ScanUrlResolver = {
  name: "polar-pfil",
  matches: matchesPolar,
  resolve: resolvePolar,
};
