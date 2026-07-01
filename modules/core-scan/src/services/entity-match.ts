// "Already tracked" — find entities the workspace ALREADY has that match a
// scan, by exact barcode or by name-token overlap. The companion app A8/A9 heads-up +
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

import { platform } from "@cobblr/platform-contract";
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
   *  by move-mode to skip entities already in the active bin (companion app parity). */
  location_id: string | null;
  matched_by: "barcode" | "name";
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

function metaBarcode(fields: Record<string, unknown>): string | null {
  const md = fields.metadata as Record<string, unknown> | null | undefined;
  const b = md && typeof md.barcode === "string" ? md.barcode.trim() : "";
  return b || null;
}

function toMatch(
  e: { kind: string; id: string; title: string; subtitle?: string; image_path?: string; detailUrl?: string; fields: Record<string, unknown> },
  info: { noun: string; qtyField: string },
  matchedBy: "barcode" | "name",
): TrackedMatch {
  const rawQty = e.fields[info.qtyField];
  const qty = typeof rawQty === "number" ? rawQty : Number(rawQty);
  const inst = e.detailUrl?.match(/^\/instances\/([^/]+)\/items\//)?.[1] ?? null;
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
      const perKind = await Promise.all(
        kinds.map(async (k) => {
          try {
            const res = await platform().entities.list(orgId, k.kind, { q: name, limit: 6 });
            return res.items
              .filter((e) => !seen.has(`${e.kind}:${e.id}`))
              // An entity that already carries a DIFFERENT barcode is a
              // different SKU — never offer it as a fuzzy match (companion app rule;
              // stops link-barcode from clobbering the wrong entity's code).
              .filter((e) => {
                const b = metaBarcode(e.fields);
                return !b || !barcode || b === barcode;
              })
              .map((e) => {
                const have = new Set(tokens(e.title));
                const shared = want.filter((t) => have.has(t)).length;
                // companion app-grade guard: sharing 2 words isn't enough for long names —
                // require the overlap to be MOST of the shorter name (≥0.6), so
                // "Prusa PLA Filament Black" doesn't match "Prusa Nozzle Kit".
                const ratio = shared / Math.max(1, Math.min(want.length, have.size));
                return { e, shared, ratio };
              })
              .filter(({ shared, ratio }) =>
                want.length === 1 ? shared === 1 : shared >= 2 && ratio >= 0.6,
              )
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
