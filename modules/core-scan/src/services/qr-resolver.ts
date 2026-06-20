// External QR resolver — the per-workspace redirect table.
//
// A scanned FOREIGN QR payload (a companion app URL, a bare Homebox number, …) is
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
   *  metadata key (e.g. "wos_id" → metadata->>'wos_id'). */
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

export type ResolveOutcome =
  | {
      outcome: "resolved";
      rule_id: string;
      rule_name: string;
      entity_kind: string;
      entity_id: string;
      detail_path: string;
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
      // "base URL once + /segment/ children" (the companion app shape): a label is
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

/** Resolve the matched key to an entity (kind, id, detail_path), or report that
 *  nothing matched. Uses platform().entities.list so module isolation holds; the
 *  filter key resolves against a native column or a metadata field. */
async function resolveEntity(
  orgId: string,
  rule: QrRule,
  key: string,
  type?: string,
): Promise<{ kind: string; id: string; detail_path: string } | { kind: string | null; missing: true }> {
  const r = rule.resolve;
  const kind = (type ? r.type_map?.[type] : undefined) || r.target_kind || null;
  if (!kind) return { kind: null, missing: true };

  const res = await platform().entities.list(orgId, kind, {
    filter: { [r.key_field]: key },
    limit: 2,
  });
  const item = res.items[0];
  if (!item) return { kind, missing: true };

  // Prefer the resolved entity's own detailUrl; fall back to the kind's
  // detail_route template (same computation as api/src/routes/qr-scan.ts).
  let detailPath = item.detailUrl;
  if (!detailPath) {
    const rec = await platform().entities.getKind(kind);
    detailPath = rec?.detail_route ? rec.detail_route.replace("{id}", item.id) : undefined;
  }
  if (!detailPath) return { kind, missing: true };
  return { kind, id: item.id, detail_path: detailPath };
}

/** Run a scanned value through the workspace's resolver rules. The FIRST rule
 *  whose match succeeds claims the scan — if its entity isn't found we STOP at
 *  `recognized_no_match` (intent was declared; do not fall through to web
 *  search). No rule matches ⇒ `no_rule` (caller runs the normal scan routine). */
export async function resolveExternalScan(
  db: Kysely<CoreScanDB>,
  orgId: string,
  value: string,
): Promise<ResolveOutcome> {
  const rules = await loadEnabledRules(db);
  for (const rule of rules) {
    const matched = matchRule(rule, value);
    if (!matched) continue;
    const resolved = await resolveEntity(orgId, rule, matched.key, matched.type);
    if ("id" in resolved) {
      return {
        outcome: "resolved",
        rule_id: rule.id,
        rule_name: rule.name,
        entity_kind: resolved.kind,
        entity_id: resolved.id,
        detail_path: resolved.detail_path,
      };
    }
    return {
      outcome: "recognized_no_match",
      rule_id: rule.id,
      rule_name: rule.name,
      key: matched.key,
      target_kind: resolved.kind,
    };
  }
  return { outcome: "no_rule" };
}
