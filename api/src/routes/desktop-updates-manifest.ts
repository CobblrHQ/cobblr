// Pure manifest logic for the desktop update feed — no express / auth / DB, so
// it's unit-testable in isolation (desktop-updates-manifest.test.ts). The route
// (desktop-updates.ts) owns the IO (file read/write) and HTTP; this owns the
// key scheme + version compare.
//
// Multiple desktop products share ONE manifest (edge-helper, studio, …). Keys are
// namespaced by product so a release for one is never served to another:
//   "<target>-<arch>"            → the default (edge-helper) feed  [unprefixed = back-compat]
//   "<product>/<target>-<arch>"  → a named product's feed
// Missing the arch-specific key falls back to a target-wide "<[product/]target>".

/** One platform's latest release. */
export interface ReleaseEntry {
  version: string;
  url: string;
  signature: string;
  notes?: string;
  pub_date?: string;
}
export type Manifest = Record<string, ReleaseEntry>;

/** A desktop product slug (edge-helper is the unprefixed default; studio, …). */
export const PRODUCT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Manifest key for a product+platform. Unprefixed when product is undefined. */
export function manifestKey(product: string | undefined, platform: string): string {
  return product ? `${product}/${platform}` : platform;
}

/** The release for a product+target+arch: arch-specific first, then target-wide. */
export function entryFor(
  manifest: Manifest,
  product: string | undefined,
  target: string,
  arch: string,
): ReleaseEntry | undefined {
  return manifest[manifestKey(product, `${target}-${arch}`)] ?? manifest[manifestKey(product, target)];
}

/** semver a > b (numeric x.y.z; a pre-release/build suffix is ignored). */
export function versionGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = parse(a);
  const [b0 = 0, b1 = 0, b2 = 0] = parse(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}
