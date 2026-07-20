// Shared types for the resolvable registry, in the contract so BOTH the platform
// impl (api/src/platform/resolvables.ts) and modules that register a provider or
// call resolveValue (via platform().resolvables) speak the same shapes.
//
// The registry itself — registration, scoring, merge, count-decides — lives in
// the api. This file is types only. See docs/design-decisions/resolvable-registry.md.

export type ResolveSurface = "scan" | "palette" | "search";
export type ResolveMatch = "exact" | "prefix" | "fuzzy";

/** Default when a provider omits `surfaces`: everything except scan, which is
 *  opt-in (D2). Exported so the registry impl and any reader agree on it. */
export const DEFAULT_SURFACES: readonly ResolveSurface[] = ["palette", "search"];

/** A key naming more than this many entities is a numbering problem, not a
 *  picking problem; the extras are dropped and `truncated` is set. */
export const MAX_CANDIDATES = 8;

/** What a provider produces per candidate. Score and provider_id are stamped by
 *  the registry, not the provider. */
export interface RawCandidate {
  entity_kind: string;
  entity_id: string;
  label: string;
  /** Disambiguating context shown in a picker (location, parent, kind). */
  sublabel?: string;
  detail_path: string;
}

export interface ResolveCandidate extends RawCandidate {
  provider_id: string;
  score: number;
}

export interface ProviderResult {
  candidates: RawCandidate[];
  /** The provider RECOGNISED the format but found nothing. Distinct from an empty
   *  result: a recognised-but-empty scan must STOP (intent was declared) rather
   *  than fall through. The registry reports `recognized_no_match` when the merged
   *  count is zero but some provider set this. */
  recognizedEmpty?: { label: string; targetKind: string | null };
}

export interface ResolveContext {
  surface: ResolveSurface;
  /** Provenance only, never a ladder input (D4). */
  source?: "typed" | "wedge" | "camera" | "bridge";
  /** Narrow candidates to one kind (scan scope), applied by providers that honour it. */
  scope?: { kind: string; filter?: Record<string, string> };
  limit?: number;
}

export interface ResolvableProvider {
  id: string;
  match: ResolveMatch;
  surfaces?: ResolveSurface[];
  rank: number;
  /** Pure of caching. Throwing is contained per provider by the registry. */
  resolve(orgId: string, value: string, ctx: ResolveContext): Promise<ProviderResult>;
}

export type ResolveOutcome =
  | { outcome: "resolved"; candidate: ResolveCandidate }
  | { outcome: "ambiguous"; candidates: ResolveCandidate[]; truncated: boolean }
  | { outcome: "recognized_no_match"; recognized: { provider_id: string; label: string; targetKind: string | null } }
  | { outcome: "no_match" };
