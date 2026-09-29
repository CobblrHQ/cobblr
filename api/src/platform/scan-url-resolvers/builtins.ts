// Built-in vendor scan-URL resolver manifests — shipped data, not code modules.
// Adding a maker the platform supports out of the box = one more entry here (or,
// at runtime, an operator-added row in the scan_url_resolvers table). The
// interpreter (./interpret.ts) reads both. See ./register.ts.

import type { ScanUrlResolverManifest } from "./types.js";

/** Polar Filament. The spool's QR (`3dqr.co/?i=<id>-<check>`) carries a key,
 *  and Polar publishes the spool as OpenTag3D JSON at `ot3dWebApi.php?i=<key>`
 *  (the page a `?j=` link redirects to). The key's check suffix is
 *  anti-enumeration: only a scanned spool resolves. No email or key is sent.
 *  The per-spool QC the HTML page (`view.php`) adds, measured tolerance and
 *  ovality and who made it, is not read: the JSON carries everything a spool
 *  record uses. */
export const POLAR_FILAMENT: ScanUrlResolverManifest = {
  id: "polar-filament",
  label: "Polar Filament",
  enabled: true,
  // A printed QR carries `i=`; a pasted JSON link carries `j=`.
  match: { pattern: "(?:3dqr\\.co|pfil\\.us)", key: "[?&][ij]=([0-9]+-[A-Za-z0-9]+)" },
  request: {
    method: "GET",
    url: "https://3dqr.co/ot3dWebApi.php?i={key}",
    // No URL here: the interpreter appends this instance's own.
    headers: { "user-agent": "CobblrScan/1.0", accept: "application/json" },
    timeout_ms: 8000,
    // Measured 2026-09-28: back-to-back calls get 429, one every 3 s is served.
    min_interval_ms: 3000,
  },
  response: {
    require: { opentag_version: "present" },
    require_any: ["tag_data.material", "tag_data.color_name"],
  },
  output: {
    source: "polar-opentag3d",
    preset: "opentag3d",
    brand: { path: "tag_data.manufacturer", default: "Polar Filament" },
    fields: {},
  },
  // A new namespace: a spool cached from the old endpoint carried none of the
  // tag's temperature ranges, UPC or colour, and would be served for good.
  cache_ns: "polar-spool-ot3d-v1",
};

export const BUILTIN_SCAN_URL_RESOLVERS: ScanUrlResolverManifest[] = [POLAR_FILAMENT];
