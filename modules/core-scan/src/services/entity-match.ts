// "Already tracked" — find entities the workspace ALREADY has that match a
// scan, by exact barcode or by name-token overlap. The heads-up banner +
// the lookup half of attach-to-existing (see scan-parity-final-mile.md).
//
// Barcode tier: every confirm stamps `metadata.barcode` on the entity it
// creates, and entity list-resolvers fall back to `metadata->>'<key>'` for
// unknown filter keys (inventory's D8 dialect). So `filter: { barcode }` IS
// the barcode index — no new framework. One trap: the contract says a
// resolver may IGNORE unknown filter keys (returning unfiltered rows), so
// every hit is post-verified against fields.metadata.barcode before it can
// claim "already tracked". A kind that doesn't expose metadata simply can't
// match by barcode — safe, never a false positive.
//
// Name tier: `q` free-text per scannable kind, then ranked by shared
// significant tokens (≥2, the same bar the combine clusters use) so "WD-40
// EZ-Reach" matches "WD-40 EZ-Reach Lubricant" but not "WD External Drive".

import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import { isJunkName } from "./enrich.js";

export interface TrackedMatch {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  image_path: string | null;
  detail_url: string | null;
  /** Instance slug parsed from the detail route (`/instances/<x>/items/…`) —
   *  the attach endpoint needs it to hit the instance-scoped CRUD path. */
  instance: string | null;
  noun: string;
  qty: number | null;
  /** Where it lives now — shown on the banner ("· 📍Garage Shelf") and used
   *  by move-mode to skip entities already in the active bin. */
  location_id: string | null;
  matched_by: "barcode" | "name" | "bin";
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "pack", "pcs", "pieces", "count",
  "set", "kit", "new", "oem", "genuine", "original", "assorted",
]);

function tokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((t) => !STOP.has(t)) ?? [];
}

/** The significant tokens the name tier PROBES the list resolver with. The
 *  resolver's `q` is a full-PHRASE substring LIKE, so probing with the whole
 *  scan name ("Honda Civic Hatchback") only returns rows that CONTAIN it and
 *  starves the ranking below. Probing token-by-token ("honda", "civic", …) and
 *  unioning is what lets a stored "2019 Honda Civic" surface. Capped at the 3
 *  longest so each kind is a few cheap lookups. Exported for the guardrail test. */
export function probeTokens(name: string): string[] {
  return [...new Set(tokens(name))].sort((a, b) => b.length - a.length).slice(0, 3);
}

/** The name-tier match decision + strength for a (scan tokens, stored title)
 *  pair: ≥2 shared significant tokens covering most of the shorter name (or the
 *  single word when the scan is one word). Exported so the rule — the Honda-Civic
 *  class the phrase-LIKE probe silently broke — is unit-tested directly. */
export function nameOverlap(want: string[], storedTitle: string): { shared: number; pass: boolean } {
  const have = new Set(tokens(storedTitle));
  const shared = want.filter((t) => have.has(t)).length;
  const ratio = shared / Math.max(1, Math.min(want.length, have.size));
  const pass = want.length === 1 ? shared === 1 : shared >= 2 && ratio >= 0.6;
  return { shared, pass };
}

function metaBarcode(fields: Record<string, unknown>): string | null {
  const md = fields.metadata as Record<string, unknown> | null | undefined;
  const b = md && typeof md.barcode === "string" ? md.barcode.trim() : "";
  return b || null;
}

function toMatch(
  e: { kind: string; id: string; title: string; subtitle?: string; image_path?: string; detailUrl?: string; fields: Record<string, unknown> },
  info: { noun: string; qtyField: string },
  matchedBy: "barcode" | "name" | "bin",
): TrackedMatch {
  const rawQty = e.fields[info.qtyField];
  const qty = typeof rawQty === "number" ? rawQty : Number(rawQty);
  // The instance slug: from the detail route when the resolver supplies one,
  // else the row's own `instance` column (assets/inventory instance rows carry
  // it) — the attach/merge endpoint needs it to hit the instance-scoped path,
  // and a plain module PATCH would 404 or target the wrong instance.
  const inst =
    e.detailUrl?.match(/^\/instances\/([^/]+)\/items\//)?.[1] ??
    (typeof e.fields.instance === "string" && e.fields.instance ? e.fields.instance : null);
  return {
    kind: e.kind,
    id: e.id,
    title: e.title,
    subtitle: e.subtitle ?? null,
    image_path: e.image_path ?? null,
    detail_url: e.detailUrl ?? null,
    instance: inst,
    noun: info.noun,
    qty: Number.isFinite(qty) ? qty : null,
    location_id: typeof e.fields.location_id === "string" ? e.fields.location_id : null,
    matched_by: matchedBy,
  };
}

export async function findTracked(
  orgId: string,
  opts: { barcode?: string | null; name?: string | null },
): Promise<{ barcode_matches: TrackedMatch[]; name_matches: TrackedMatch[] }> {
  const kinds = platform().entities.listScannable();
  const barcode = opts.barcode?.trim() || null;
  const name = opts.name && !isJunkName(opts.name) ? opts.name.trim() : null;

  const barcodeMatches: TrackedMatch[] = [];
  if (barcode) {
    const perKind = await Promise.all(
      kinds.map(async (k) => {
        try {
          const res = await platform().entities.list(orgId, k.kind, {
            filter: { barcode },
            limit: 3,
          });
          // Post-verify: only rows whose metadata REALLY carries this barcode
          // count (a resolver that ignored the filter returns arbitrary rows).
          return res.items
            .filter((e) => metaBarcode(e.fields) === barcode)
            .map((e) => toMatch(e, k, "barcode"));
        } catch {
          return [];
        }
      }),
    );
    barcodeMatches.push(...perKind.flat());
  }

  const nameMatches: TrackedMatch[] = [];
  if (name) {
    const want = tokens(name);
    if (want.length) {
      const seen = new Set(barcodeMatches.map((m) => `${m.kind}:${m.id}`));
      // Probe token-by-token (see probeTokens) and union — one `q: name` phrase
      // probe would starve the ranking. The shared-token ratio (nameOverlap)
      // then decides, so "Prusa PLA Filament Black" won't match "Prusa Nozzle Kit".
      const probes = probeTokens(name);
      const perKind = await Promise.all(
        kinds.map(async (k) => {
          try {
            const byId = new Map<string, ResolvedEntity>();
            const pages = await Promise.all(
              probes.map((t) =>
                platform()
                  .entities.list(orgId, k.kind, { q: t, limit: 8 })
                  .catch(() => ({ items: [] as ResolvedEntity[] })),
              ),
            );
            for (const page of pages)
              for (const e of page.items) byId.set(`${e.kind}:${e.id}`, e);
            return [...byId.values()]
              .filter((e) => !seen.has(`${e.kind}:${e.id}`))
              // An entity that already carries a DIFFERENT barcode is a
              // different SKU — never offer it as a fuzzy match
              // (stops link-barcode from clobbering the wrong entity's code).
              .filter((e) => {
                const b = metaBarcode(e.fields);
                return !b || !barcode || b === barcode;
              })
              .map((e) => ({ e, ...nameOverlap(want, e.title) }))
              .filter(({ pass }) => pass)
              .map(({ e, shared }) => ({ m: toMatch(e, k, "name"), shared }));
          } catch {
            return [];
          }
        }),
      );
      nameMatches.push(
        ...perKind
          .flat()
          .sort((a, b) => b.shared - a.shared)
          .slice(0, 3)
          .map(({ m }) => m),
      );
    }
  }

  return { barcode_matches: barcodeMatches, name_matches: nameMatches };
}

/** Everything that LIVES in one bin (location), across the scannable kinds.
 *  The single-SKU-bin shortcut (scan the bin's QR → adjust that item's count
 *  directly): `single` is true when EXACTLY one item calls this bin home — its
 *  qty IS the bin count (Cobblr multi-location = one row per location, so the
 *  count is bin-scoped by construction). Derived, never declared: drop a second
 *  SKU in the bin and the shortcut stops firing on its own. Same defensive
 *  post-verify as the barcode tier — a resolver that ignores the location_id
 *  filter can't fake a single-SKU bin. */
export async function findBinContents(
  orgId: string,
  locationId: string,
): Promise<{ items: TrackedMatch[]; single: boolean }> {
  const kinds = platform().entities.listScannable();
  const perKind = await Promise.all(
    kinds.map(async (k) => {
      try {
        const res = await platform().entities.list(orgId, k.kind, {
          filter: { location_id: locationId },
          limit: 6,
        });
        return res.items
          .filter((e) => typeof e.fields.location_id === "string" && e.fields.location_id === locationId)
          .map((e) => toMatch(e, k, "bin"));
      } catch {
        return [];
      }
    }),
  );
  const items = perKind.flat();
  return { items, single: items.length === 1 };
}
