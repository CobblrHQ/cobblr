// One-time, idempotent self-heal for catalog instances the camera sheet latched
// to the stock face.
//
// DONE WHEN: every instance override with `stock_latched: true` also carries
// `stock_latch_checked`, on prod + staging + dev consistently; then delete this
// file and its onBoot call in module.ts. (The leftover `stock_latch_checked`
// key is inert once this is gone.)
//
// It lives in INVENTORY, not the kernel, because it reads `inventory_parts` and
// reasons about stock — both of which are this module's business. A first draft
// sat in api/src/platform and the isolation lint caught it: "kernel hardcodes
// module name 'inventory'". The lint was right; the fix was not to baseline it
// but to put the code where the data lives.
//
// The bug, fixed at source in web/src/lib/scanQuantity.ts + ScanResultModal:
// the camera sheet sent `quantity: qty > 0 ? qty : 1` on every confirm, so the
// server's trait-derived default — which deliberately gives a UNIQUE catalog
// target no count at all — was unreachable from the app's own camera. Every
// scanned book counted as one in stock, and the first one latched its instance
// to the stock face permanently (disclosure.ts rung 3, which never re-probes by
// design so a drained stock instance cannot flip back).
//
// A fix at the source only helps the NEXT scan. Every bookshelf, film shelf,
// wardrobe and collection already scanned into still shows a quantity stepper,
// cost, supplier URL, serial number and fifteen stock actions on a paperback,
// and will forever. That is what CLAUDE.md §8.1 exists for: found on the live
// demo, where all nine books had done it.
//
// What it unlatches, and what it must not:
//   • SKIP an instance whose bundle DECLARED a measured unit (filament kg, yarn
//     skein, groceries unit). That latch came from the manifest at install, not
//     from data, and is correct with or without rows.
//   • SKIP an instance carrying an explicit `stock` boolean — the user's own
//     one-tap choice outranks every derivation, including this one.
//   • UNLATCH only when NOTHING in the instance carries stock character beyond
//     "one of it exists": every row at qty <= 1, no reorder point, no measured
//     unit. That is precisely the population the sheet's phantom 1 created. A
//     real stock instance leaves that state the moment anything is counted,
//     restocked or given a reorder point, and re-latches itself then through
//     the same signal it always used.
//
// Non-destructive both ways: unlatching hides the stock panels, it drops no
// qty, cost or unit, and one tap on the instance's stock toggle overrides it.
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";

type MetaDb = Kysely<{
  orgs: { id: string };
  entity_kind_overrides: {
    org_id: string;
    target_kind: string;
    target_id: string;
    config: Record<string, unknown> | null;
  };
}>;

type Candidate = { targetId: string; instance: string };

/** Instances still latched that this heal has not looked at yet, grouped by org
 *  so each tenant is opened at most once. Meta-only: a workspace with nothing
 *  to heal costs one query for the whole boot and opens no tenant pool. */
async function candidatesByOrg(meta: MetaDb): Promise<Map<string, Candidate[]>> {
  const rows = await meta
    .selectFrom("entity_kind_overrides")
    .select(["org_id", "target_id", "config"])
    .where("target_kind", "=", "instance")
    .where(sql<boolean>`config->>'stock_latched' = 'true'`)
    .where(sql<boolean>`coalesce(config->>'stock_latch_checked', 'false') <> 'true'`)
    .execute();

  const byOrg = new Map<string, Candidate[]>();
  for (const r of rows) {
    const config = (r.config as Record<string, unknown> | null) ?? {};
    // The user's own choice wins over any derivation, including this one.
    if (typeof config.stock === "boolean") continue;
    // A bundle-declared measured unit is stock by manifest, not by data.
    const declaredUnit = typeof config.qty_unit === "string" ? config.qty_unit.trim() : "";
    if (declaredUnit !== "" && declaredUnit !== "each") continue;
    // target_id is `<module>:<instance>`; only this module's own instances.
    const [moduleName, ...rest] = String(r.target_id).split(":");
    const instance = rest.join(":");
    if (moduleName !== "inventory" || !instance) continue;
    const list = byOrg.get(r.org_id) ?? [];
    list.push({ targetId: r.target_id, instance });
    byOrg.set(r.org_id, list);
  }
  return byOrg;
}

/** Returns the number of instances actually returned to the catalog face. */
export async function healCatalogStockLatch(): Promise<number> {
  const meta = platform().db.meta as unknown as MetaDb;
  let byOrg: Map<string, Candidate[]>;
  try {
    byOrg = await candidatesByOrg(meta);
  } catch (err) {
    console.error("[inventory.heal-latch] candidate scan failed:", (err as Error).message);
    return 0;
  }
  if (byOrg.size === 0) return 0;

  let unlatched = 0;
  for (const [orgId, candidates] of byOrg) {
    // Per-org try/catch: one workspace's failure never blocks the rest.
    // withDb releases the tenant pool for us — a boot sweep that holds one pool
    // per tenant exhausts Postgres (CLAUDE.md §8.1).
    try {
      const verdicts = await platform().tenants.withDb(orgId, async (raw) => {
        const db = raw as Kysely<Record<string, never>>;
        const out: Array<{ c: Candidate; hasStock: boolean }> = [];
        for (const c of candidates) {
          // "Does anything here carry stock character beyond existing?" One row
          // answering yes leaves the latch alone.
          const probe = await sql<{ has_stock: boolean }>`
            select exists (
              select 1
              from inventory_parts
              where instance = ${c.instance}
                and (
                  qty > 1
                  or min_qty is not null
                  or (unit is not null and unit <> '' and unit <> 'each')
                )
            ) as has_stock
          `.execute(db);
          out.push({ c, hasStock: probe.rows[0]?.has_stock ?? true }); // no answer → keep the latch
        }
        return out;
      });

      for (const { c, hasStock } of verdicts) {
        // patchDerivedConfig MERGES, so the latch is turned off rather than
        // deleted — every reader tests `=== true`, so false and absent mean the
        // same thing, and merging can never clobber a concurrent rename.
        await platform().instances.patchDerivedConfig(orgId, "inventory", c.instance, {
          stock_latch_checked: true,
          ...(hasStock ? {} : { stock_latched: false }),
        });
        if (!hasStock) {
          unlatched++;
          console.log(`[inventory.heal-latch] org ${orgId}: ${c.instance} back to the catalog face`);
        }
      }
    } catch (err) {
      console.error(`[inventory.heal-latch] org ${orgId} skipped:`, (err as Error).message);
    }
  }
  return unlatched;
}
