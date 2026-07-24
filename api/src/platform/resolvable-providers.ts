// Built-in resolvable providers registered at boot. See resolvables.ts and
// docs/design-decisions/resolvable-registry.md.
//
// Platform-owned providers (their data is meta or generic):
//
//   minted-token — a Cobblr label's `/qr/<token>` (or a bare token). Highest
//     rank: a token we minted is the most authoritative match there is.
//   identifier-field — a kind declares which of its fields are identifiers
//     (fieldRole "identifier"): a serial number, an asset tag. Resolves a value
//     against those fields for every kind the workspace has, so a declared serial
//     resolves with NO hand-written QR rule.
//
// The QR-RULE provider is registered by core-scan, which owns the rules table
// (module isolation): see modules/core-scan/src/api. Together these three cover
// the scan surface end to end.

import { identifierFieldNames } from "@cobblr/platform-contract";
import { qrTokenFromScan } from "@cobblr/platform-contract/qr-token";
import {
  registerResolvable,
  type ProviderResult,
  type RawCandidate,
  type ResolveContext,
} from "./resolvables.js";
import * as entities from "./entities.js";
import { resolveQrToken } from "../routes/qr-scan.js";

/** Cap on kinds probed per resolve, so a workspace with many identifier-bearing
 *  kinds cannot turn one scan into an unbounded fan-out. Kinds beyond this are
 *  dropped; a scoped resolve (ctx.scope) probes exactly one and never hits it. */
const MAX_KINDS_PROBED = 24;

/** Build the detail path for a resolved entity, through the ONE shared decision
 *  (entities.resolveDetailPath) so this, qr-scan.ts, and core-scan's resolver can't
 *  drift — a registry hit lands exactly where a native scan would, instance items
 *  included. */
async function detailPathFor(
  kind: string,
  item: { id: string; detailUrl?: string; instance?: string },
  routeCache: Map<string, string | null>,
): Promise<string | undefined> {
  if (!routeCache.has(kind)) {
    const rec = await entities.getKind(kind);
    routeCache.set(kind, rec?.detail_route ?? null);
  }
  return entities.resolveDetailPath({
    kind,
    id: item.id,
    instance: typeof item.instance === "string" ? item.instance : null,
    detailUrl: item.detailUrl ?? null,
    baseDetailRoute: routeCache.get(kind) ?? null,
  });
}

/** Register the built-in providers. Idempotent (registerResolvable dedupes by
 *  id), so a re-call during a hot reload is a no-op. */
export function registerBuiltinResolvables(): void {
  registerResolvable({
    id: "minted-token",
    match: "exact",
    surfaces: ["scan", "palette", "search"],
    // The most authoritative match: a token Cobblr minted onto a label.
    rank: 100,
    async resolve(orgId: string, value: string, ctx: ResolveContext): Promise<ProviderResult> {
      // A scan scoped to some kind is not asking about a workspace-wide token.
      if (ctx.scope?.kind) return { candidates: [] };
      const token = qrTokenFromScan(value);
      if (!token) return { candidates: [] };
      const r = await resolveQrToken(token);
      // Only THIS workspace's token, and only one that lands on a detail page.
      if (!r.ok || r.org_id !== orgId || !r.detail_path || !r.entity_kind || !r.entity_id) {
        return { candidates: [] };
      }
      const item = await entities.lookup(orgId, r.entity_kind, r.entity_id).catch(() => null);
      return {
        candidates: [
          {
            entity_kind: r.entity_kind,
            entity_id: r.entity_id,
            label: item?.title || r.entity_id,
            sublabel: r.entity_kind,
            detail_path: r.detail_path,
          },
        ],
      };
    },
  });

  registerResolvable({
    id: "identifier-field",
    match: "exact",
    surfaces: ["scan", "palette", "search"],
    // Above fuzzy text, below a minted token: a declared identifier is a
    // deliberate mark, more specific than a name match, less authoritative than a
    // token we minted ourselves. resolvable-registry.md 3.3.
    rank: 90,
    async resolve(orgId: string, value: string, ctx: ResolveContext): Promise<ProviderResult> {
      const kinds = await entities.listKindsForOrg(orgId);

      // Only kinds that declare an identifier field, and (when scoped) only the
      // scoped kind. Sorted for a stable probe order; capped so the fan-out is
      // bounded.
      let targets = kinds
        .map((k) => ({ kind: k.id, fields: identifierFieldNames(k) }))
        .filter((t) => t.fields.length > 0);
      if (ctx.scope?.kind) targets = targets.filter((t) => t.kind === ctx.scope!.kind);
      targets = targets.slice(0, MAX_KINDS_PROBED);

      const candidates: RawCandidate[] = [];
      const routeCache = new Map<string, string | null>();

      // One kind at a time, but a kind's identifier fields OR together in a single
      // list call is not expressible through the filter API (it ANDs), so probe
      // each field. In practice a kind has one or two. A value matching several
      // rows is an ambiguity the registry surfaces; this provider just reports
      // every row it found.
      for (const t of targets) {
        for (const field of t.fields) {
          const res = await entities.list(orgId, t.kind, {
            filter: { [field]: value, ...(ctx.scope?.filter ?? {}) },
            limit: 5,
          });
          for (const item of res.items) {
            const detail = await detailPathFor(t.kind, item, routeCache);
            if (!detail) continue; // no reachable page — not a destination
            candidates.push({
              entity_kind: t.kind,
              entity_id: item.id,
              label: item.title || item.id,
              sublabel: t.kind, // slice 1: kind as the disambiguator; richer context later
              detail_path: detail,
            });
          }
        }
      }

      // Dedupe within this provider: the same row can match on two identifier
      // fields (a value that is both serial and asset tag), and that is one thing.
      const seen = new Set<string>();
      const deduped = candidates.filter((c) => {
        const key = `${c.entity_kind}:${c.entity_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { candidates: deduped };
    },
  });
}
