// Polar Filament — 3dqr.co spool QR resolver.
//
// Polar prints a QR on every spool that resolves to `3dqr.co/?i=<serial>`,
// which redirects to a per-spool data page ("Royal Blue PLA 1.75 1kg",
// serial #52435). The page has no JSON API, so we fetch + parse its HTML —
// tolerant of markup drift (it returns null on any miss, and the scan
// pipeline falls back to its generic path).
//
// Temps (nozzle/bed) and "needs drying" live only on the physical label and
// the type spec, NOT this page — so the QR scrape can't fill them. They
// belong to the filament *type*; the scan creates/updates a spool.

import type { ScanUrlResolver, ScanUrlResolution } from "@cobblr/platform-contract";

/** Accepts a bare host too (`3dqr.co/?i=…`), since QR decoders sometimes
 *  drop the scheme. */
function matchesPolar(value: string): boolean {
  return /(?:^|\/\/|\.|\s)3dqr\.co\//i.test(value.trim());
}

async function resolvePolar(value: string): Promise<ScanUrlResolution | null> {
  const raw = value.trim();
  if (!matchesPolar(raw)) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "CobblrScan/1.0 (+https://cobblr.me)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const spool = parsePolarSpool(html);
  if (!spool) return null;
  return {
    source: "polar-3dqr",
    name: spool.name,
    brand: spool.brand,
    category: "filament",
    entityType: "part",
    fields: {
      material: spool.material,
      color: spool.color,
      diameter: spool.diameter,
      size: spool.size,
      // The spool serial doubles as the maker's batch/lot code on this label.
      batch_code: spool.serial,
    },
  };
}

export const polarResolver: ScanUrlResolver = {
  name: "polar-3dqr",
  matches: matchesPolar,
  resolve: resolvePolar,
};

export interface PolarSpool {
  name: string;
  material: string | null;
  color: string | null;
  diameter: string | null;
  size: string | null;
  serial: string | null;
  brand: string;
}

const MATERIALS = ["PLA+", "PLA", "PETG", "ABS", "ASA", "TPU", "Nylon", "PC", "PVA", "HIPS"];

/** Parse a Polar spool data page. Pure + tolerant — returns null if it can't
 *  find the identity line or a serial. Exported for the smoke test. */
export function parsePolarSpool(html: string): PolarSpool | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  // The label line: "Royal Blue PLA 1.75 1kg" → name, diameter (mm), size.
  const line = text.match(/([A-Za-z][\w '+./\-]*?)\s+(\d+(?:[.,]\d+)?)\s+([\d.]+)\s*(kg|g)\b/i);
  const serialM = text.match(/#\s?(\d{3,})/);
  if (!line && !serialM) return null;

  const name = (line?.[1] ?? text.match(/Spool Details\s+(.+?)\s+#/i)?.[1] ?? "Filament").trim();
  const material =
    MATERIALS.find((m) => new RegExp(`\\b${m.replace("+", "\\+")}\\b`, "i").test(name)) ?? null;
  const color = material
    ? name.replace(new RegExp(`\\s*\\b${material.replace("+", "\\+")}\\b\\s*`, "i"), " ").trim() || null
    : name || null;

  return {
    name,
    material,
    color,
    diameter: line?.[2] ? `${line[2].replace(",", ".")} mm` : null,
    size: line?.[3] && line[4] ? `${line[3]} ${line[4].toLowerCase()}` : null,
    serial: serialM?.[1] ?? null,
    brand: "Polar Filament",
  };
}
