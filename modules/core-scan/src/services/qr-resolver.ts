// External QR resolver — the per-workspace redirect table.
//
// A scanned FOREIGN QR payload (an external-system URL, a bare Homebox number, …) is
// run through the workspace's ordered rules. The first rule whose `match`
// succeeds claims the scan: it extracts a key and resolves it to a Cobblr entity
// via platform().entities.list (which already falls back to a metadata-JSON
// field when there's no native column — resolvers.ts D8). On success the caller
// navigates to the entity's detail page, exactly as a native scan would.
//
// Pure translation: this turns a foreign payload into the SAME (entity_kind,
// entity_id, detail_path) a native /qr/<token> scan produces. Everything
// downstream is native behaviour. Opt-in: zero rules ⇒ outcome "no_rule" ⇒ the
// scan flows through the normal barcode/identify routine.
//
// See docs/design-decisions/external-qr-resolver.md.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { ResolveOutcome as RegistryOutcome, ResolveCandidate as RegistryCandidate } from "@cobblr/platform-contract/resolvables";
import type { CoreScanDB } from "../db.js";

export type QrMatchSpec =
  | { type: "url_prefix"; value: string }
  | { type: "url_base"; value: string }
  | { type: "regex"; value: string }
  | { type: "bare"; value?: string };

export type QrTransform = "trim" | "strip_leading_zeros" | "lowercase";

export interface QrExtractSpec {
  source?: "path_segment_after_prefix" | "capture_group" | "whole_value";
  /** regex capture-group name or index that holds the key. */
  group?: string | number;
  /** a second group/segment naming the entity type (for type_map). */
  type_from?: string | number;
  transform?: QrTransform[];
}

export interface QrResolveSpec {
  /** fixed target kind, e.g. "inventory:part". */
  target_kind?: string;
  /** extracted type → kind, e.g. { printers: "machines:machine" }. */
  type_map?: Record<string, string>;
  /** the entity field carrying the foreign key — a native column OR a
   *  metadata key (e.g. "ext_id" → metadata->>'ext_id'). */
  key_field: string;
}

export interface QrRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match: QrMatchSpec;
  extract: QrExtractSpec;
  resolve: QrResolveSpec;
}

/** One entity a scanned key could mean. */
export interface ResolveCandidate {
  entity_kind: string;
  entity_id: string;
  entity_label: string;
  detail_path: string;
  /** Which rule produced it: one key can match several rules across kinds. */
  rule_id: string;
  rule_name: string;
}

/** Cap on candidates carried back for disambiguation. A key matching more than
 *  a handful is a numbering problem rather than a picking problem, and the UI
 *  says so instead of rendering a wall. */
export const MAX_CANDIDATES = 8;

export type ResolveOutcome =
  | {
      outcome: "resolved";
      rule_id: string;
      rule_name: string;
      entity_kind: string;
      entity_id: string;
      entity_label: string;
      detail_path: string;
    }
  | {
      /** The key names more than one entity. NEVER pick for the user: serials
       *  are unique per product line, not per workspace, so two parts share one
       *  legitimately and only the person holding it knows which. */
      outcome: "ambiguous";
      key: string;
      candidates: ResolveCandidate[];
      /** More matches existed than MAX_CANDIDATES. */
      truncated: boolean;
    }
  | {
      outcome: "recognized_no_match";
      rule_id: string;
      rule_name: string;
      key: string;
      target_kind: string | null;
    }
  | { outcome: "no_rule" };

// ─────────────────────────── pure helpers ───────────────────────────

function applyTransforms(raw: string, transforms?: QrTransform[]): string {
  let v = raw;
  for (const t of transforms ?? []) {
    if (t === "trim") v = v.trim();
    else if (t === "lowercase") v = v.toLowerCase();
    // strip_leading_zeros: "0042" → "42", but keep a lone "0".
    else if (t === "strip_leading_zeros") v = v.replace(/^0+(?=\d)/, "");
  }
  return v;
}

/** Try one rule against a payload. Returns the extracted key (+ optional type)
 *  when the rule's `match` succeeds, else null. A malformed regex never throws —
 *  it just means "this rule doesn't match." */
export function matchRule(rule: QrRule, value: string): { key: string; type?: string } | null {
  const m = rule.match;
  const ex = rule.extract ?? {};
  try {
    if (m.type === "url_prefix") {
      if (!m.value || !value.startsWith(m.value)) return null;
      // the first path segment after the prefix (stop at / ? #)
      const seg = value.slice(m.value.length).split(/[/?#]/)[0] ?? "";
      if (!seg) return null;
      return { key: applyTransforms(seg, ex.transform) };
    }
    if (m.type === "url_base") {
      // "base URL once + /segment/ children" (the base + segment shape): a label is
      // <base>/<segment>/<key>. The segment names the entity TYPE (resolve.type_map
      // maps it → kind), the next segment is the foreign key. One rule covers a
      // whole host. Tolerant of a trailing slash on the base.
      if (!m.value) return null;
      const base = m.value.replace(/\/+$/, "");
      if (value !== base && !value.startsWith(base + "/")) return null;
      const rest = value.slice(base.length).replace(/^\/+/, "");
      const segs = rest.split(/[/?#]/).filter(Boolean);
      if (segs.length < 2) return null; // need /<type>/<key>
      return { key: applyTransforms(segs[1] as string, ex.transform), type: segs[0] };
    }
    if (m.type === "regex") {
      if (!m.value) return null;
      const match = new RegExp(m.value).exec(value);
      if (!match) return null;
      const pick = (g: string | number | undefined): string | undefined => {
        if (g === undefined) return undefined;
        return typeof g === "number" ? match[g] : match.groups?.[g];
      };
      const rawKey = pick(ex.group) ?? match[1] ?? match[0];
      if (!rawKey) return null;
      const type = ex.type_from !== undefined ? pick(ex.type_from) : undefined;
      return { key: applyTransforms(rawKey, ex.transform), type };
    }
    if (m.type === "bare") {
      // a plain value, not a URL; if a guard pattern is given it must match.
      if (/:\/\//.test(value)) return null;
      if (m.value && !new RegExp(m.value).test(value)) return null;
      return { key: applyTransforms(value, ex.transform) };
    }
  } catch {
    return null;
  }
  return null;
}

/** How many entities a key names decides the outcome. Pure and exported so the
 *  rule can be tested without a tenant: this is where the shipped bug lived, and
 *  "one match navigates, several ask" is the whole contract. */
export function decideOutcome(
  merged: ResolveCandidate[],
  ctx: {
    value: string;
    truncated: boolean;
    firstBare: { rule_id: string; rule_name: string; key: string; kind: string } | null;
  },
): ResolveOutcome {
  if (merged.length === 1) return { outcome: "resolved", ...merged[0]! };
  if (merged.length > 1) {
    return {
      outcome: "ambiguous",
      key: ctx.firstBare?.key ?? ctx.value,
      candidates: merged.slice(0, MAX_CANDIDATES),
      truncated: ctx.truncated || merged.length > MAX_CANDIDATES,
    };
  }
  // A rule recognised the FORMAT but nothing carries the key. Intent was
  // declared, so this stops here rather than falling through to web search.
  if (ctx.firstBare) {
    return {
      outcome: "recognized_no_match",
      rule_id: ctx.firstBare.rule_id,
      rule_name: ctx.firstBare.rule_name,
      key: ctx.firstBare.key,
      target_kind: ctx.firstBare.kind || null,
    };
  }
  return { outcome: "no_rule" };
}

/** Merge candidate lists from several rules, dropping repeats.
 *
 *  Two rules can legitimately name the SAME entity (a broad rule and a narrow
 *  one over the same field). That is one thing, not an ambiguity, so it must
 *  resolve straight through rather than prompting a pick between a row and
 *  itself. Exported for tests. */
export function mergeCandidates(lists: ResolveCandidate[][]): ResolveCandidate[] {
  const seen = new Set<string>();
  const out: ResolveCandidate[] = [];
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.entity_kind}:${c.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// ───────────────────────── DB + entity resolve ─────────────────────────

interface QrRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match_spec: Record<string, unknown>;
  extract_spec: Record<string, unknown>;
  resolve_spec: Record<string, unknown>;
}

function rowToRule(row: QrRuleRow): QrRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    match: row.match_spec as unknown as QrMatchSpec,
    extract: (row.extract_spec ?? {}) as unknown as QrExtractSpec,
    resolve: row.resolve_spec as unknown as QrResolveSpec,
  };
}

export async function loadEnabledRules(db: Kysely<CoreScanDB>): Promise<QrRule[]> {
  const rows = await db
    .selectFrom("core_scan_qr_rules")
    .selectAll()
    .where("enabled", "=", true)
    .orderBy("position", "asc")
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => rowToRule(r as unknown as QrRuleRow));
}

/** Resolve the matched key to EVERY entity it names, or report that nothing
 *  matched. Uses platform().entities.list so module isolation holds; the filter
 *  key resolves against a native column or a metadata field.
 *
 *  Returns all matches rather than the first. The caller decides what one, many
 *  or none means; picking here is how a duplicate serial used to resolve to
 *  whichever row happened to sort first. */
async function resolveEntity(
  orgId: string,
  rule: QrRule,
  key: string,
  type?: string,
): Promise<{ kind: string; candidates: ResolveCandidate[]; truncated: boolean }> {
  const r = rule.resolve;
  const kind = (type ? r.type_map?.[type] : undefined) || r.target_kind || null;
  if (!kind) return { kind: "", candidates: [], truncated: false };

  const res = await platform().entities.list(orgId, kind, {
    filter: { [r.key_field]: key },
    limit: MAX_CANDIDATES + 1,
  });
  const truncated = res.items.length > MAX_CANDIDATES;
  const items = truncated ? res.items.slice(0, MAX_CANDIDATES) : res.items;
  if (items.length === 0) return { kind, candidates: [], truncated: false };

  // Prefer each entity's own detailUrl; fall back to the kind's detail_route
  // template (same computation as api/src/routes/qr-scan.ts). The kind lookup is
  // per-kind, not per-item, so it costs one call however many candidates there are.
  let template: string | undefined;
  let templateLoaded = false;
  const candidates: ResolveCandidate[] = [];
  for (const item of items) {
    let detailPath = item.detailUrl;
    if (!detailPath) {
      if (!templateLoaded) {
        template = (await platform().entities.getKind(kind))?.detail_route ?? undefined;
        templateLoaded = true;
      }
      detailPath = template ? template.replace("{id}", item.id) : undefined;
    }
    // An entity with no reachable detail page cannot be offered as a
    // destination; skip it rather than hand back a dead candidate.
    if (!detailPath) continue;
    candidates.push({
      entity_kind: kind,
      entity_id: item.id,
      entity_label: item.title || item.id,
      detail_path: detailPath,
      rule_id: rule.id,
      rule_name: rule.name,
    });
  }
  return { kind, candidates, truncated };
}

/** Run a scanned value through the workspace's resolver rules.
 *
 *  A URL-shaped rule claims the scan outright: its match is structural, so a hit
 *  means that system's label and no later rule can be talking about the same
 *  thing. If the entity is missing we STOP at `recognized_no_match` (intent was
 *  declared; do not fall through to web search).
 *
 *  `bare` rules share one key space and cannot claim exclusively. "A7" may be a
 *  part serial under one rule and a unit serial under another, and rule ORDER
 *  must not decide which the person is holding. So every bare rule that matches
 *  is tried and its candidates merged; the count then picks the outcome.
 *
 *  No rule matches ⇒ `no_rule` (caller runs the normal scan routine). */
export async function resolveExternalScan(
  db: Kysely<CoreScanDB>,
  orgId: string,
  value: string,
): Promise<ResolveOutcome> {
  const rules = await loadEnabledRules(db);

  const bareLists: ResolveCandidate[][] = [];
  let truncated = false;
  let firstBare: { rule: QrRule; key: string; kind: string } | null = null;

  for (const rule of rules) {
    const matched = matchRule(rule, value);
    if (!matched) continue;
    const resolved = await resolveEntity(orgId, rule, matched.key, matched.type);

    if (rule.match.type !== "bare") {
      // Structural match: this rule owns the scan either way.
      const first = resolved.candidates[0];
      if (first) {
        if (resolved.candidates.length === 1) {
          return { outcome: "resolved", ...first };
        }
        return {
          outcome: "ambiguous",
          key: matched.key,
          candidates: resolved.candidates,
          truncated: resolved.truncated,
        };
      }
      return {
        outcome: "recognized_no_match",
        rule_id: rule.id,
        rule_name: rule.name,
        key: matched.key,
        target_kind: resolved.kind || null,
      };
    }

    if (!firstBare) firstBare = { rule, key: matched.key, kind: resolved.kind };
    truncated = truncated || resolved.truncated;
    bareLists.push(resolved.candidates);
  }

  const ruleOutcome = decideOutcome(mergeCandidates(bareLists), {
    value,
    truncated,
    firstBare: firstBare
      ? {
          rule_id: firstBare.rule.id,
          rule_name: firstBare.rule.name,
          key: firstBare.key,
          kind: firstBare.kind,
        }
      : null,
  });

  // The workspace's own rules had nothing to say. Before giving up, ask the
  // resolvable registry: a value can be a DECLARED identifier (a part's serial,
  // fieldRole "identifier") or a minted token, resolving with no hand-written
  // rule. Only on no_rule — a rule that recognised the format but found nothing
  // already declared intent and must NOT fall through. The rule loop above keeps
  // its URL-claims-exclusively semantic untouched; the registry is a fallback,
  // not a replacement. See docs/design-decisions/resolvable-registry.md §6.
  if (ruleOutcome.outcome === "no_rule") {
    const reg = await platform().resolvables.resolve(orgId, value, {
      surface: "scan",
      source: "camera",
    });
    return mapRegistryOutcome(reg, value);
  }
  return ruleOutcome;
}

/** Registry ResolveOutcome → this module's ResolveOutcome, so the camera and
 *  wedge clients (shipped in #1227) see the same shape whether a workspace rule
 *  or a declared identifier produced the hit. A registry `no_match` becomes
 *  `no_rule` — nothing recognised it, run the normal scan routine. */
function mapRegistryOutcome(reg: RegistryOutcome, value: string): ResolveOutcome {
  const toCandidate = (c: RegistryCandidate): ResolveCandidate => ({
    entity_kind: c.entity_kind,
    entity_id: c.entity_id,
    entity_label: c.label,
    detail_path: c.detail_path,
    rule_id: c.provider_id,
    rule_name: c.provider_id,
  });
  if (reg.outcome === "resolved") return { outcome: "resolved", ...toCandidate(reg.candidate) };
  if (reg.outcome === "ambiguous") {
    return { outcome: "ambiguous", key: value, candidates: reg.candidates.map(toCandidate), truncated: reg.truncated };
  }
  if (reg.outcome === "recognized_no_match") {
    return {
      outcome: "recognized_no_match",
      rule_id: reg.recognized.provider_id,
      rule_name: reg.recognized.label,
      key: value,
      target_kind: reg.recognized.targetKind,
    };
  }
  return { outcome: "no_rule" };
}
