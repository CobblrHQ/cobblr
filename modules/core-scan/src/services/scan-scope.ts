// Scan scope (#6892, scan-serial-number-resolution.md D5): the lookup twin of
// ?unitOf. A QC pass over a bin of Widget X says "everything I scan now is a
// Widget X", and a serial shared with Gadget Y then resolves to Widget X's
// with no picker. The scope is held by the person's session (the browser) and
// sent with each resolve; it is applied here, to the candidates, before the
// outcome is decided.
//
// Generic: a kind (a collection, "widgets:item"), or a record the candidate
// is or is a unit of. Nothing serial-specific. A scope that filters every
// candidate out never guesses: the unscoped outcome stands, marked outside.
//
// Also the picker's offer: each ambiguous candidate carries the record it is
// a unit of, so "only Widget X from now on" is one tap.

import { platform } from "@cobblr/platform-contract";
import { UNIT_OF } from "@cobblr/platform-contract/holdings";
import { decideOutcome, type ResolveCandidate, type ResolveOutcome } from "./qr-resolver.js";

export interface ScanScope {
  kind?: string | null;
  within?: { kind: string; id: string } | null;
}

export interface ScopeNote {
  applied: boolean;
  /** Nothing the scope holds matched: every match is shown, unscoped. */
  outside: boolean;
}

export type ScopedOutcome = ResolveOutcome & { scope?: ScopeNote };

const byKind = (cs: ResolveCandidate[]) => {
  const m = new Map<string, ResolveCandidate[]>();
  for (const c of cs) m.set(c.entity_kind, [...(m.get(c.entity_kind) ?? []), c]);
  return m;
};

/** The candidates the scope holds: of its kind, or the record itself or a
 *  unit of it. One pairing read per kind among the candidates. */
export async function inScope(orgId: string, candidates: ResolveCandidate[], scope: ScanScope): Promise<ResolveCandidate[]> {
  let held = scope.kind ? candidates.filter((c) => c.entity_kind === scope.kind) : candidates;
  const within = scope.within;
  if (!within) return held;
  const units = new Set<string>();
  for (const [kind, group] of byKind(held)) {
    const pairs = await platform().pairings.findByTargets({ orgId, sourceKind: kind, targetKind: within.kind, targetIds: [within.id], relationshipKind: UNIT_OF });
    const ids = new Set(group.map((c) => c.entity_id));
    for (const p of pairs) if (ids.has(p.sourceId)) units.add(`${kind}:${p.sourceId}`);
  }
  held = held.filter((c) => (c.entity_kind === within.kind && c.entity_id === within.id) || units.has(`${c.entity_kind}:${c.entity_id}`));
  return held;
}

/** The outcome as the scope decides it: the matches it holds are counted
 *  alone, so one of two shared serials inside Widget X resolves. With none
 *  held, the outcome is what it was, and says it is outside the scope. */
export async function applyScanScope(orgId: string, outcome: ResolveOutcome, scope: ScanScope | null | undefined): Promise<ScopedOutcome> {
  if (!scope || (!scope.kind && !scope.within)) return outcome;
  const all: ResolveCandidate[] =
    outcome.outcome === "resolved"
      ? [{ entity_kind: outcome.entity_kind, entity_id: outcome.entity_id, entity_label: outcome.entity_label, detail_path: outcome.detail_path, rule_id: outcome.rule_id, rule_name: outcome.rule_name }]
      : outcome.outcome === "ambiguous"
        ? outcome.candidates
        : [];
  if (!all.length) return outcome;
  const held = await inScope(orgId, all, scope);
  if (!held.length) return { ...outcome, scope: { applied: true, outside: true } };
  const decided = decideOutcome(held, { value: "", truncated: false, firstBare: null });
  const key = outcome.outcome === "ambiguous" ? outcome.key : "";
  return { ...(decided.outcome === "ambiguous" ? { ...decided, key } : decided), scope: { applied: true, outside: false } };
}

/** Each ambiguous candidate's own scope offer: the record it is a unit of
 *  ("only Widget X from now on"), when it is one. */
export async function withScopeOffers(orgId: string, outcome: ScopedOutcome): Promise<ScopedOutcome> {
  if (outcome.outcome !== "ambiguous") return outcome;
  const parentOf = new Map<string, { kind: string; id: string; title: string }>();
  for (const [kind, group] of byKind(outcome.candidates)) {
    const pairs = await platform().pairings.findBySources({ orgId, sourceKind: kind, sourceIds: group.map((c) => c.entity_id), targetKind: kind, relationshipKind: UNIT_OF });
    for (const p of pairs) {
      const model = await platform().entities.lookup(orgId, kind, p.targetId);
      if (model) parentOf.set(`${kind}:${p.sourceId}`, { kind, id: p.targetId, title: model.title });
    }
  }
  return {
    ...outcome,
    candidates: outcome.candidates.map((c) => {
      const within = parentOf.get(`${c.entity_kind}:${c.entity_id}`);
      return within ? { ...c, scope: { within } } : c;
    }),
  };
}
