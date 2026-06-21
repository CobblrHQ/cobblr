// Built-in vendor scan-URL resolver manifests — shipped data, not code modules.
// Adding a maker the platform supports out of the box = one more entry here (or,
// at runtime, an operator-added row in the scan_url_resolvers table). The
// interpreter (./interpret.ts) reads both. See ./register.ts.

import type { ScanUrlResolverManifest } from "./types.js";

/** Polar Filament — the QR (`3dqr.co/?i=<id>-<checksum>`) carries a spool ref;
 *  pfil.us returns structured spool JSON (Polar gave us the API directly).
 *  Replaces the old maker-scan/vendors/polar.ts code 1:1. */
export const POLAR_FILAMENT: ScanUrlResolverManifest = {
  id: "polar-filament",
  label: "Polar Filament",
  enabled: true,
  match: { pattern: "(?:3dqr\\.co|pfil\\.us)", key: "[?&]i=([0-9]+-[A-Za-z0-9]+)" },
  request: {
    method: "GET",
    url: "https://pfil.us/query_spool.php?i={key}&email={env:POLAR_QUERY_EMAIL}&version=1.00",
    headers: { "user-agent": "CobblrScan/1.0 (+https://cobblr.me)" },
    env_defaults: { POLAR_QUERY_EMAIL: "contact@example.com" },
    timeout_ms: 8000,
  },
  response: {
    require: { status: "OK" },
    require_any: ["spool.material_name", "spool.color"],
    root: "spool",
  },
  output: {
    source: "polar-pfil",
    name: { concat: ["color", "material_name"], sep: " ", fallback: "Filament" },
    brand: { path: "brand_name", default: "Polar Filament" },
    category: "filament",
    entityType: "part",
    fields: {
      material: "material_name",
      color: "color",
      diameter: { path: "diameter", suffix: " mm" },
      size: { path: "mass_grams", scale: 0.001, suffix: " kg" },
      batch_code: { path: "id", stringify: true },
      nozzle_temp: "nozzle_temp",
      bed_temp: "bed_temp",
    },
  },
  cache_ns: "polar-spool-pfil-v2",
};

export const BUILTIN_SCAN_URL_RESOLVERS: ScanUrlResolverManifest[] = [POLAR_FILAMENT];
