// Classifies a bundle update by the SemVer delta between the installed version
// and the latest catalog version, so the update FLOW can differ per tier
// (owner-approved policy):
//
//   • patch (x.y.Z) → silent auto-apply, audited via the server-side
//                      `bundle_installed` activity entry. No toast.
//   • minor (x.Y.0) → auto-apply + a toast saying what was added.
//   • major (X.0.0) → NEVER silent. Keep the explicit prompt + confirm.
//   • prompt         → the SAFE fallback for anything we can't confidently
//                      classify (non-numeric / pre-release / build-metadata
//                      versions, downgrades, garbage). Behaves like major:
//                      always prompt, never auto-apply.
//
// SAFETY: auto-apply (patch/minor) is only ever wired when the classifier is
// confident. Any ambiguity biases to `prompt` — "better a correct prompt than
// a data-losing silent apply." Callers must ALSO gate auto-apply on the apply
// being conflict-free (no upgrade_conflicts / needs_enable / field_def_collision);
// this classifier only decides the SemVer tier, not whether the apply is safe.

export type BundleUpdateTier = "patch" | "minor" | "major" | "prompt";

/** Strict dotted-numeric triple, optional leading "v". Rejects pre-release /
 *  build-metadata suffixes (e.g. "1.0.0-beta", "1.0.0+build") on purpose — a
 *  pre-release must never silently auto-apply. Missing minor/patch segments
 *  pad to 0 ("1" → 1.0.0, "1.2" → 1.2.0). */
const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function parse(v: string): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * Classify an update from installed → latest.
 * Returns `"prompt"` (the safest branch) for any non-semver input, a downgrade,
 * or a no-op (installed === latest) — callers treat `prompt` exactly like
 * `major`: surface the explicit prompt, never auto-apply.
 */
export function classifyBundleUpdate(installed: string, latest: string): BundleUpdateTier {
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return "prompt"; // garbage / pre-release → never silent

  const [aMaj, aMin, aPatch] = a;
  const [bMaj, bMin, bPatch] = b;

  // Not a forward move (equal or downgrade) → nothing safe to auto-apply.
  if (bMaj < aMaj) return "prompt";
  if (bMaj === aMaj && bMin < aMin) return "prompt";
  if (bMaj === aMaj && bMin === aMin && bPatch <= aPatch) return "prompt";

  if (bMaj !== aMaj) return "major";
  if (bMin !== aMin) return "minor";
  return "patch";
}

/**
 * A "latest" that is BEHIND (or equal to) the installed version is not an
 * update, and must not be dressed as one.
 *
 * The registry can lag a deploy: install 0.10.0 from a fresh manifest while the
 * catalog still serves 0.9.4 and the dashboard read "v0.10.0 -> v0.9.4 - Update
 * now" - an invitation to hand-confirm a downgrade, on every workspace, for the
 * whole lag window. The tier classifier already refuses to AUTO-apply these;
 * this is the other half: do not offer them at all.
 *
 * Unparseable versions return false - they keep today's banner-and-prompt
 * behaviour, because "cannot read it" must not silently hide a real update.
 */
export function isDowngradeOrSame(installed: string, latest: string): boolean {
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return false;
  if (b[0] !== a[0]) return b[0] < a[0];
  if (b[1] !== a[1]) return b[1] < a[1];
  return b[2] <= a[2];
}

/** Whether a tier is eligible for auto-apply (patch or minor). Major/prompt are
 *  NOT — they always require the explicit confirm flow. */
export function tierAutoApplies(tier: BundleUpdateTier): boolean {
  return tier === "patch" || tier === "minor";
}

/**
 * Whether a bundle manifest ships any catalog shells (top-level OR inside a
 * feature). Catalog rows are 100% user-imported data (bundles ship shells only),
 * so any upgrade that tears a catalog down risks destroying them.
 *
 * The PERMANENT fix lives on the server: `uninstallBundleId` now deletes catalog
 * rows ONLY on a real uninstall, not on the upgrade-replace path (see
 * api/src/routes/bundles.ts — the delete is gated on `teardownResources`), so an
 * upgrade self-heals and imported rows survive. This client heuristic is the
 * ROLLOUT-WINDOW backstop: during a deploy the new web can briefly run against an
 * OLD api image that still deletes on upgrade, so we keep forcing `prompt` for
 * catalog-bearing updates until the server fix is universally deployed. It can be
 * relaxed in a later release once no pre-fix api image is in service.
 *
 * Accepts `unknown` because `manifest` is loosely typed at the call site; reads
 * defensively so a malformed manifest just returns `true` (safe → prompt).
 */
export function manifestShipsCatalogs(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return true; // unknown shape → be safe
  const m = manifest as { catalogs?: unknown; features?: Array<{ catalogs?: unknown }> };
  const arr = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  if (arr(m.catalogs) > 0) return true;
  for (const f of Array.isArray(m.features) ? m.features : []) {
    if (arr(f?.catalogs) > 0) return true;
  }
  return false;
}

/**
 * Whether applying this update could tear down user catalog data on a pre-fix
 * (still-deleting) api image, and therefore must NOT silently auto-apply.
 *
 * Requires BOTH the installed and the incoming manifest ON PURPOSE. Inspecting
 * only the new manifest misses the DROP case: a bundle that shipped a catalog in
 * the INSTALLED version but removed it in the new one still triggers the
 * catalog teardown (keyed by the bundle's external_id, not by the new manifest),
 * so its imported rows are deleted with no re-seed — the silent data-loss edge.
 * By taking two required args, "the caller forgot the installed manifest" is a
 * compile error, not a latent data-loss bug. `installedManifest` may be
 * undefined (an older install row without a stored manifest) → treated as unsafe
 * (→ prompt), never as "no catalogs".
 */
export function updateMayTeardownCatalogs(installedManifest: unknown, newManifest: unknown): boolean {
  return manifestShipsCatalogs(installedManifest) || manifestShipsCatalogs(newManifest);
}
