// The resolvable registry: one place to ask "what could this value mean, on this
// surface". See docs/design-decisions/resolvable-registry.md.
//
// A provider declares HOW it matches (exact/prefix/fuzzy), WHICH surfaces it
// serves (scan/palette/search), and a RANK. A caller names a surface; the
// registry runs only the providers serving it, merges their candidates, dedupes
// by entity, and lets the COUNT decide: one navigates, several ask, none is a
// miss. It never picks between two different entities — that is the ambiguity bug
// this generalises (resolvable-registry.md D7).
//
// This is the SERVER half (identifier fields, QR rules, minted tokens, text). The
// client half (palette actions, features) is separate and merges against these by
// score in the browser (D5). Scan resolves entirely here.

// Types + shared constants live in the contract so modules that register a
// provider or call resolveValue (via platform().resolvables) share them. This
// file owns the IMPLEMENTATION and re-exports the types so existing importers
// (the route, the providers, the tests) are unaffected by the move.
import {
  DEFAULT_SURFACES,
  MAX_CANDIDATES,
  type ResolveSurface,
  type ResolveMatch,
  type ResolveOutcome,
  type ResolvableProvider,
  type ResolveContext,
  type ResolveCandidate,
  type ProviderResult,
} from "@cobblr/platform-contract/resolvables";

export {
  DEFAULT_SURFACES,
  MAX_CANDIDATES,
  type ResolveSurface,
  type ResolveMatch,
  type RawCandidate,
  type ResolveCandidate,
  type ProviderResult,
  type ResolveContext,
  type ResolvableProvider,
  type ResolveOutcome,
} from "@cobblr/platform-contract/resolvables";

const MATCH_BONUS: Record<ResolveMatch, number> = { exact: 50, prefix: 20, fuzzy: 0 };

const providers: ResolvableProvider[] = [];

/** Register a provider. Idempotent by id (a re-import or hot reload is a no-op,
 *  returns false). Enforces D3: a provider serving `scan` MUST match exactly,
 *  because scan auto-navigates and a fuzzy auto-navigation is the unsafe combo. */
export function registerResolvable(p: ResolvableProvider): boolean {
  const surfaces = p.surfaces ?? [...DEFAULT_SURFACES];
  if (surfaces.includes("scan") && p.match !== "exact") {
    throw new Error(
      `resolvable "${p.id}" serves the scan surface but match is "${p.match}". ` +
        `Scan auto-navigates on a single hit, so it requires match: "exact" — a fuzzy ` +
        `auto-navigation sends you somewhere you did not choose. See resolvable-registry.md D3.`,
    );
  }
  if (providers.some((x) => x.id === p.id)) return false;
  providers.push({ ...p, surfaces });
  return true;
}

/** Test seam only. */
export function _clearResolvables(): void {
  providers.length = 0;
}

/** Providers serving a surface, highest rank first (a stable read for tests/UX). */
export function providersForSurface(surface: ResolveSurface): ResolvableProvider[] {
  return providers
    .filter((p) => (p.surfaces ?? DEFAULT_SURFACES).includes(surface))
    .sort((a, b) => b.rank - a.rank);
}

/**
 * Resolve a value on a surface. Runs every provider serving the surface, merges
 * and dedupes by entity, and lets the count decide the outcome. Score orders the
 * ambiguous/palette list; it NEVER auto-selects between two different entities.
 */
export async function resolveValue(
  orgId: string,
  value: string,
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  const v = value.trim();
  if (!v) return { outcome: "no_match" };

  const eligible = providers.filter((p) => (p.surfaces ?? DEFAULT_SURFACES).includes(ctx.surface));

  // Independent lookups; a thrown provider is contained, not fatal.
  const results = await Promise.all(
    eligible.map(async (p) => {
      try {
        return { p, r: await p.resolve(orgId, v, ctx) };
      } catch (e) {
        // A provider failure is contained: it contributes nothing, the others
        // still resolve. Never let one bad provider turn a resolve into an error.
        console.error(`[resolvables] provider "${p.id}" threw for org ${orgId}:`, e);
        return { p, r: { candidates: [] } as ProviderResult };
      }
    }),
  );

  const merged: ResolveCandidate[] = [];
  const seen = new Set<string>();
  let recognized: { provider_id: string; label: string; targetKind: string | null } | null = null;
  let overflow = false;

  for (const { p, r } of results) {
    if (r.recognizedEmpty && !recognized) {
      recognized = { provider_id: p.id, label: r.recognizedEmpty.label, targetKind: r.recognizedEmpty.targetKind };
    }
    for (const c of r.candidates) {
      const key = `${c.entity_kind}:${c.entity_id}`;
      if (seen.has(key)) continue; // two providers can name the same entity — one thing
      seen.add(key);
      merged.push({ ...c, provider_id: p.id, score: p.rank + MATCH_BONUS[p.match] });
    }
  }

  // Highest score first. Array.prototype.sort is stable, so equal scores keep
  // provider (registration/rank) order.
  merged.sort((a, b) => b.score - a.score);

  if (merged.length === 1) return { outcome: "resolved", candidate: merged[0]! };
  if (merged.length > 1) {
    overflow = merged.length > MAX_CANDIDATES;
    return { outcome: "ambiguous", candidates: merged.slice(0, MAX_CANDIDATES), truncated: overflow };
  }
  if (recognized) return { outcome: "recognized_no_match", recognized };
  return { outcome: "no_match" };
}
