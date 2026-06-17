// Scan-URL resolvers. A scanned QR is often a URL on a maker's site that
// encodes a SPECIFIC product (a Polar Filament spool → `3dqr.co/?i=<serial>`).
// Treated as a barcode it triggers the generic web-search path, which finds
// the maker's *marketing* page, not the product. So the platform holds a
// registry: a connector module (maker-scan) registers one matcher+resolver
// per vendor via platform().scan.registerUrlResolver, and core-scan's
// enrichBarcodeItem asks platform().scan.resolveUrl(value) as step 0.
//
// Same modular seam as registerComputedContext: a module populates it at
// boot, the platform reads it, and neither core-scan nor the kernel imports
// any specific vendor. The vendor list lives entirely in the connector.

import type { ScanUrlResolver, ScanUrlResolution } from "@cobblr/platform-contract";

const resolvers: ScanUrlResolver[] = [];

/** Register a vendor scan-URL resolver. Called from a connector module's boot
 *  via platform().scan.registerUrlResolver(). Idempotent per `name` so a
 *  double-mount can't register the same vendor twice. */
export function registerScanUrlResolver(resolver: ScanUrlResolver): void {
  if (resolvers.some((r) => r.name === resolver.name)) return;
  resolvers.push(resolver);
}

/** Resolve a scanned value through the registered vendor resolvers, in
 *  registration order. Returns the first hit, or null if no resolver claims
 *  or successfully parses it. A throwing matcher/resolver is swallowed so a
 *  flaky vendor can never break the generic barcode path. */
export async function resolveScanUrl(
  value: string,
  opts?: { force?: boolean },
): Promise<ScanUrlResolution | null> {
  const v = value?.trim();
  if (!v) return null;
  for (const r of resolvers) {
    let claimed = false;
    try {
      claimed = r.matches(v);
    } catch {
      claimed = false;
    }
    if (!claimed) continue;
    try {
      const res = await r.resolve(v, opts);
      if (res) return res;
    } catch {
      // fall through to the next resolver / the caller's generic path
    }
  }
  return null;
}

/** Test seam: how many vendors are registered. */
export function registeredScanUrlResolverCount(): number {
  return resolvers.length;
}
