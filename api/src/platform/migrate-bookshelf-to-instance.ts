// HISTORICAL DATA MIGRATION — not kernel logic.
// DONE WHEN: no org's Bookshelf install still keys its field defs to
// inventory:part (the boot pass reports orgsTouched=0 on prod + staging +
// dev consistently); then delete this file and its boot call.
//
// The Bookshelf bundle (<=0.1.x) put its fields — author / isbn / year /
// read_status / rating — straight onto `inventory:part`, i.e. onto the
// workspace's DEFAULT inventory instance. That instance is ALWAYS stock (it IS
// your inventory, never a catalog — see one-record-substrate.md), so a bookshelf
// built on it could never show the lean catalog face no matter what disclosure
// derived: your novels wore a quantity, a reorder point, a supplier and a
// warranty. 0.2.0 fixes that by giving Bookshelf its own `bookshelf` instance,
// which discloses lean and opens on a wall of covers.
//
// A shape change must SELF-HEAL an existing install. We never tell someone "we
// changed our code, so uninstall your bookshelf and start again" (CLAUDE.md
// §8.1). Without this pass, upgrading to 0.2.0 would strip the field defs off
// inventory:part and create an empty new shelf, stranding every book in
// Inventory with its author/ISBN suddenly unlabelled. So:
//
//   META side:
//     1. provision the `bookshelf` instance (its nav entry),
//     2. seed its presentation override (label + glyph + item_noun "book" +
//        qty_unit "each" — the lean signal a catalog carries at install),
//     3. re-key the bundle's field defs  inventory:part → bookshelf:item,
//     4. rewrite the bundle row's manifest to the instance shape + bump to
//        0.2.0, so the dashboard stops offering an "update" and this pass
//        terminates (orgsTouched=0) once every workspace is past it.
//   TENANT side:
//     5. move the books onto the shelf (inventory_parts.instance:
//        'inventory' → 'bookshelf'), so they appear under the new tab with
//        their fields instead of stranded among the screws.
//
// "Is a book" = what the bundle itself defined a book as: any of ITS fields is
// populated. A row with an author or an ISBN is a book; a row with neither is
// somebody's screws and is left exactly where it is. Deliberately conservative:
// stranding a book on /inventory is a cosmetic miss the user can fix, while
// dragging a real part onto the bookshelf is data damage.
//
// Idempotent: a manifest already carrying provides_instances is skipped;
// createInstance is guarded by getInstance; the re-key and the row move both
// filter on the OLD value, so a second run is a no-op. Skip with
// COBBLR_SKIP_HISTORICAL_MIGRATIONS=1. Once every production org reports
// orgsTouched=0 consistently, this file can be deleted.
//
// RUNS IN THE API PROCESS ONLY. createInstance validates against the in-process
// module registry, which loadAllModules populates at boot — so this cannot be
// called from a test process (it dies on "Module 'inventory' isn't registered").
// Its integration test drives it through the test-support trigger instead, which
// is also why `force` exists. Nothing else should pass it.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";
import { createInstance, getInstance } from "./instances.js";
import { upsertOverride } from "./entity-kind-overrides.js";

const BOOKSHELF_EXTERNAL_ID = "cobblr.community.bookshelf";
const INSTANCE_NAME = "bookshelf";
const DISPLAY_NAME = "Bookshelf";
const GLYPH = "📚";
const ITEM_NOUN = "book";

interface BookshelfFieldDef {
  entity_kind?: string;
  name: string;
  [k: string]: unknown;
}
interface StoredManifest {
  version?: string;
  provides_instances?: unknown[];
  field_defs?: BookshelfFieldDef[];
  features?: Array<{ wires?: Array<{ source_kind?: string; [k: string]: unknown }>; [k: string]: unknown }>;
  [k: string]: unknown;
}

function parseManifest(raw: unknown): StoredManifest | null {
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as StoredManifest;
  } catch {
    return null;
  }
}

/** Convert one (org, bookshelf-bundle) install to the instance shape.
 *  Idempotent. Returns whether it did anything + how many books it moved. */
async function migrateOne(
  orgId: string,
  bundleId: string,
  manifest: StoredManifest,
): Promise<{ migrated: boolean; booksMoved: number }> {
  // Already the instance shape (a fresh 0.2.0 install, or a prior run)? Skip.
  if (Array.isArray(manifest.provides_instances) && manifest.provides_instances.length > 0) {
    return { migrated: false, booksMoved: 0 };
  }
  const fieldNames = (manifest.field_defs ?? []).map((f) => f.name).filter(Boolean);
  // A bookshelf with no fields of its own gives us nothing to identify a book
  // by. Re-shape the bundle, but never guess at which rows to move.
  const kind = `${INSTANCE_NAME}:item`;

  // 1. The instance (its nav entry). Guarded, so a partial prior run or a
  //    user-made instance of the same name isn't duplicated.
  if (!(await getInstance(orgId, INSTANCE_NAME))) {
    await createInstance({
      orgId,
      moduleName: "inventory",
      instanceName: INSTANCE_NAME,
      displayName: DISPLAY_NAME,
      isDefault: false,
    });
  }

  // 2. Presentation + the lean signal. qty_unit "each" (no measured unit) means
  //    no creation-time stock latch, so the shelf discloses LEAN — which is the
  //    entire point of the reshape. insertOnly: a user's own rename survives.
  await upsertOverride({
    orgId,
    targetKind: "instance",
    targetId: `inventory:${INSTANCE_NAME}`,
    displayLabel: DISPLAY_NAME,
    icon: GLYPH,
    config: { item_noun: ITEM_NOUN, qty_unit: "each", parent: null },
    insertOnly: true,
  });

  // 3. Re-key the bundle's field defs to where the instance UI reads them.
  //    Scoped by bundle_id, so a field another bundle put on inventory:part is
  //    untouched.
  await meta
    .updateTable("module_field_defs")
    .set({ entity_kind: kind })
    .where("org_id", "=", orgId)
    .where("bundle_id", "=", bundleId)
    .where("entity_kind", "=", "inventory:part")
    .execute();

  // 4. Rewrite the bundle row to the instance manifest + bump, so the shape is
  //    stable and this pass terminates.
  const newManifest: StoredManifest = { ...manifest, version: "0.2.0" };
  newManifest.provides_instances = [
    {
      module: "inventory",
      instance_name: INSTANCE_NAME,
      display_name: DISPLAY_NAME,
      glyph: GLYPH,
      item_noun: ITEM_NOUN,
      qty_unit: "each",
      field_defs: (manifest.field_defs ?? []).map((f) => ({ ...f, entity_kind: kind })),
    },
  ];
  newManifest.field_defs = [];
  // The spine-label wire moved with the books: it fired on inventory:part, and
  // the books no longer are one.
  if (Array.isArray(newManifest.features)) {
    newManifest.features = newManifest.features.map((feat) => ({
      ...feat,
      wires: (feat.wires ?? []).map((w) =>
        w.source_kind === "inventory:part" ? { ...w, source_kind: kind } : w,
      ),
    }));
  }
  await meta
    .updateTable("bundles")
    .set({
      // jsonb-replace-ok: rewriting the manifest IS this migration.
      manifest: sql`${JSON.stringify(newManifest)}::jsonb` as never,
      version: "0.2.0",
    })
    .where("id", "=", bundleId)
    .execute();
  // Re-point any already-installed spine-label binding at the new kind, so a
  // print action doesn't silently stop offering itself on the moved books.
  await meta
    .updateTable("entity_action_bindings")
    .set({ source_kind: kind })
    .where("org_id", "=", orgId)
    .where("bundle_id", "=", bundleId)
    .where("source_kind", "=", "inventory:part")
    .execute();

  // 5. Move the books onto the shelf. Only rows still on the default instance,
  //    and only ones the bundle's OWN fields identify as books — so a re-run is
  //    a no-op and a screw is never dragged onto the bookshelf.
  let booksMoved = 0;
  if (fieldNames.length > 0) {
    const tdb = await getTenantDb(orgId);
    const belongs = sql.join(
      fieldNames.map((n) => sql`((metadata ->> ${n}) is not null and (metadata ->> ${n}) <> '')`),
      sql` or `,
    );
    const res = await sql<{ id: string }>`
      update inventory_parts
         set instance = ${INSTANCE_NAME}
       where instance = 'inventory' and (${belongs})
      returning id
    `.execute(tdb);
    booksMoved = res.rows.length;
  }

  return { migrated: true, booksMoved };
}

/** Boot-time entry point. Converts every still-old-shape Bookshelf install to
 *  the instance shape. Cheap on the happy path: one indexed meta read, and no
 *  tenant pool is opened unless a workspace actually needs healing. */
export async function migrateBookshelfToInstance(opts?: { force?: boolean }): Promise<{
  orgsTouched: number;
  booksMoved: number;
}> {
  // `force` is for the test-support trigger ONLY: CI sets the skip flag for the
  // whole job (boot passes must not sweep the shared test DB), and this pass's
  // own integration test needs it to actually run. Boot never passes it.
  if (!opts?.force && process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { orgsTouched: 0, booksMoved: 0 };
  }
  const rows = await meta
    .selectFrom("bundles")
    .select(["id", "org_id", "manifest"])
    .where("external_id", "=", BOOKSHELF_EXTERNAL_ID)
    .execute();
  // Filter to the old shape BEFORE opening any tenant pool.
  const targets = rows
    .map((r) => ({ ...r, parsed: parseManifest(r.manifest) }))
    .filter(
      (r) => r.parsed && !(Array.isArray(r.parsed.provides_instances) && r.parsed.provides_instances.length > 0),
    );
  if (targets.length === 0) return { orgsTouched: 0, booksMoved: 0 };

  const orgs = new Set<string>();
  let booksMoved = 0;
  for (const t of targets) {
    try {
      const out = await migrateOne(t.org_id, t.id, t.parsed!);
      if (out.migrated) {
        orgs.add(t.org_id);
        booksMoved += out.booksMoved;
        console.log(
          `[migrate-bookshelf] org ${t.org_id}: bookshelf → its own instance, ${out.booksMoved} book(s) moved`,
        );
      }
    } catch (err) {
      // Per-org: one broken workspace must never block the rest.
      console.error(`[migrate-bookshelf] org ${t.org_id} failed:`, (err as Error).message);
    } finally {
      // Boot-time sweeps must not hold a pool per tenant — that exhausts
      // Postgres connections (CLAUDE.md §8.1).
      evictTenantPool(t.org_id);
    }
  }
  return { orgsTouched: orgs.size, booksMoved };
}
