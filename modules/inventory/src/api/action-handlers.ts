// Action handlers — the wire-engine-callable side of inventory.
//
// Today:
//   - inventory.adjust-stock — direct stock mutation triggered by
//     wires or HTTP. Reads partId + delta from ctx.event.payload
//     (or ctx.args), does an UPDATE, re-emits inventory.stock.changed.
//   - inventory.disassemble-kit — kit → N children. Reads the
//     Rebrickable BOM catalog, spawns inventory:part rows + writes
//     matches/derived-from pairings.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

// B1 cleanup (2026-05-25-audit.md): no more direct selectFrom on
// core_catalogs_* — the disassemble handler now uses the
// platform().catalogs surface instead. Pairings go through
// platform().pairings.createMany.

let registered = false;

interface AdjustStockPayload {
  partId?: string;
  delta?: number;
  reason?: string;
}

export function registerInventoryActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("inventory.adjust-stock", async (ctx) => {
    // Args take precedence (an admin can hardwire a wire to "always
    // add 1"); otherwise we pull from the event payload.
    const args = (ctx.args as AdjustStockPayload | null) ?? {};
    const ev = (ctx.event?.payload as AdjustStockPayload | null) ?? {};
    const partId = args.partId ?? ev.partId;
    const delta = args.delta ?? ev.delta;
    const reason = args.reason ?? ev.reason ?? "wire-driven adjustment";
    if (!partId || typeof delta !== "number" || delta === 0) {
      return { ok: true, skipped: true, reason: "missing partId or delta" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const updated = await db
      .updateTable("inventory_parts")
      .set({
        qty: sql<string>`qty + ${delta}::numeric`,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .returning(["id", "name", "qty"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "part_not_found" };
    // Re-emit the stock-changed event so the existing
    // wire-of-record (inventory.stock.changed → projects.set-dep-
    // satisfied) keeps working — this action is additive, not a
    // replacement for the direct HTTP stock-adjust.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
      reason,
    });
    return {
      ok: true,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
    };
  });

  // ─────────────────────── disassemble-kit ─────────────────────────
  //
  // ctx.entity is the kit (an inventory:part). We:
  //   1. Find a `matches → core-catalogs:entry` pairing whose
  //      catalog is a rebrickable-sets catalog. external_id is the
  //      Rebrickable set_num (e.g. "75192-1").
  //   2. Find the BOM catalog (rebrickable-inventory-parts) and
  //      query its entries where payload->>'set_num' = set_num.
  //      Requires the BOM was seeded with set_num joined in.
  //   3. Look up part metadata (name + img_url) from the
  //      rebrickable-parts catalog for each unique part_num.
  //   4. INSERT one inventory_parts row per BOM line, carrying the
  //      Rebrickable img_url, qty, and metadata (color, is_spare,
  //      derived_from_kit_id, set_num, state=loose).
  //   5. Write `matches → core-catalogs:entry` for each new part →
  //      its Rebrickable part entry, plus `derived-from` back to
  //      the kit.
  //   6. Update the kit's metadata.state = "parted-out".
  platform().actions.registerHandler("inventory.disassemble-kit", async (ctx) => {
    const kitId = ctx.entity.id;
    const xdb = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;

    // 1. Find the matched catalog entry.
    const matched = await platform().entities.walkPairings(
      ctx.orgId,
      { kind: "inventory:part", id: kitId },
      { rel: "matches", dir: "out", kind: "core-catalogs:entry" },
    );
    const match = matched[0];
    if (!match) {
      return {
        ok: false,
        error: "no_match",
        message:
          "This part isn't matched to any catalog. Match it to a Rebrickable set first.",
      };
    }
    const setNum = match.fields.external_id as string | undefined;
    if (!setNum) {
      return { ok: false, error: "bad_match", message: "Match is missing external_id." };
    }

    // 2. Resolve catalogs by semantic type — preferred over coupling
    // to the bundle's external_id suffix. Workspaces that haven't
    // re-installed the rebrickable bundle v0.5+ (which sets
    // semantic_type) get a friendlier name-based fallback.
    const setsCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.set");
    const bomCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.bom");
    const partsCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.part");

    if (!bomCat) {
      return {
        ok: false,
        error: "no_bom_catalog",
        message:
          "No catalog declares semantic_type='lego.bom'. Install the rebrickable-catalogs bundle (v0.5+) and run `node scripts/seed-rebrickable.mjs --include-bom`.",
      };
    }
    // setsCat is informational — used only for the user-facing error
    // when the match isn't to a sets catalog. If the workspace hasn't
    // declared semantic_type='lego.set' yet, skip the strict check
    // and just trust the match.
    if (setsCat && match.fields.catalog_id !== setsCat.id) {
      return {
        ok: false,
        error: "not_a_set",
        message: "Matched catalog isn't the canonical lego.set catalog. Match this part to a Rebrickable set first.",
      };
    }

    // 3. Query BOM entries by set_num. The seeder synthesises set_num
    // into each row's payload — if rows are missing it, the BOM was
    // seeded before the set_num enrichment shipped.
    const bomRows = await platform().catalogs.queryEntries({
      orgId: ctx.orgId,
      catalogId: bomCat.id,
      payloadEq: { set_num: setNum },
    });
    if (bomRows.length === 0) {
      return {
        ok: false,
        error: "no_bom_rows",
        message: `No BOM rows for set ${setNum}. Either the set isn't in the BOM dump or your BOM data predates the set_num enrichment — re-run the seeder.`,
      };
    }

    // 4. Look up part metadata from the rebrickable-parts catalog.
    const partNums = Array.from(
      new Set(bomRows.map((r) => String(r.payload.part_num ?? "")).filter(Boolean)),
    );
    const partEntries = partsCat && partNums.length > 0
      ? await platform().catalogs.queryEntries({
          orgId: ctx.orgId,
          catalogId: partsCat.id,
          externalIdIn: partNums,
        })
      : [];
    const partByNum = new Map<string, typeof partEntries[number]>(
      partEntries.map((p) => [p.externalId, p]),
    );

    // 5. Spawn inventory:part rows + write pairings. Batched —
    // a typical Rebrickable set has 300-700 BOM rows; row-by-row
    // INSERT was 2000+ SQL roundtrips. Single bulk INSERT with
    // RETURNING + two bulk pairing inserts keeps it to 3 queries
    // total. (Audit item N3.)
    const insertRows = bomRows.map((row) => {
      const partNum = String(row.payload.part_num ?? "");
      const colorId = String(row.payload.color_id ?? "");
      const isSpare = String(row.payload.is_spare ?? "").toLowerCase() === "true";
      const qty = Number(row.payload.quantity ?? 1);
      const imgUrl =
        typeof row.payload.img_url === "string" && (row.payload.img_url as string).length > 0
          ? (row.payload.img_url as string)
          : null;
      const partEntry = partByNum.get(partNum);
      const partName =
        (partEntry?.payload.name as string | undefined) ?? `Part ${partNum}`;
      return {
        partEntryId: partEntry?.id ?? null,
        values: {
          name: partName,
          qty: String(qty),
          unit: "each",
          image_path: imgUrl,
          metadata: sql`${JSON.stringify({
            color_id: colorId,
            is_spare: isSpare,
            derived_from_kit_id: kitId,
            set_num: setNum,
            part_num: partNum,
            lifecycle: "loose",
          })}::jsonb` as never,
        },
      };
    });
    // Bulk insert into the inventory module's own table — that stays
    // direct since it's same-module access.
    const insertedRows = await xdb
      .insertInto("inventory_parts")
      .values(insertRows.map((r) => r.values))
      .returning("id")
      .execute();
    const spawned = insertedRows.length;
    // Pairing writes go through platform().pairings.createMany — no
    // more touching entity_pairings directly from inventory.
    const matchesValues = insertedRows
      .map((r, i) => {
        const partEntryId = insertRows[i]?.partEntryId;
        if (!partEntryId) return null;
        return {
          orgId: ctx.orgId,
          sourceKind: "inventory:part",
          sourceId: r.id,
          targetKind: "core-catalogs:entry",
          targetId: partEntryId,
          relationshipKind: "matches",
          createdBy: ctx.userId,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const derivedFromValues = insertedRows.map((r) => ({
      orgId: ctx.orgId,
      sourceKind: "inventory:part",
      sourceId: r.id,
      targetKind: "inventory:part",
      targetId: kitId,
      relationshipKind: "derived-from",
      createdBy: ctx.userId,
    }));
    await platform().pairings.createMany(matchesValues);
    await platform().pairings.createMany(derivedFromValues);

    // 6. Mark the kit parted-out.
    const kit = await xdb
      .selectFrom("inventory_parts")
      .select("metadata")
      .where("id", "=", kitId)
      .executeTakeFirst();
    const existingMeta = (kit?.metadata as Record<string, unknown> | null) ?? {};
    await xdb
      .updateTable("inventory_parts")
      .set({
        metadata: sql`${JSON.stringify({ ...existingMeta, lifecycle: "parted-out" })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", kitId)
      .execute();

    return {
      ok: true,
      kitId,
      setNum,
      spawned,
      message: `Spawned ${spawned} parts from set ${setNum}.`,
    };
  });

  // ─────────────────────── set-status ──────────────────────────────
  // A small, member-appropriate write: set a part's metadata.status
  // (the Lego set Built/Unbuilt/Missing-pieces field). This is the
  // canonical action a custom (Tier B) app block invokes — capability
  // -gated (`inventory:set-status`) like any other, so a worker can only
  // run it if granted. partId comes from args or the targeted entity.
  platform().actions.registerHandler("inventory.set-status", async (ctx) => {
    const args = (ctx.args as { partId?: string; status?: string } | null) ?? {};
    const partId = args.partId ?? (ctx.entity as { id?: string } | null)?.id;
    const status = typeof args.status === "string" ? args.status.trim().slice(0, 60) : undefined;
    if (!partId || !status) return { ok: false, error: "missing partId or status" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["metadata"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "part_not_found" };
    const existing = (row.metadata as Record<string, unknown> | null) ?? {};
    await db
      .updateTable("inventory_parts")
      .set({
        metadata: sql`${JSON.stringify({ ...existing, status })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .execute();
    return { ok: true, partId, status };
  });
}

