// Action handlers for the Lego/BrickLink domain. Registered at module load
// (api/index.ts side-effect).
//
// disassemble-kit lived in the generic inventory module, where it baked in Lego
// semantic types (lego.set/bom/part) + Rebrickable's BOM payload schema
// (part_num, color_id, …) + Lego copy — use-case knowledge in a kernel module.
// It belongs HERE, the Lego domain module (marketplace band, "built for the Lego
// workspace use case"). Inventory now exposes the GENERIC writes it needs
// (inventory:create-items, inventory:update-item); this handler owns the
// Lego-specific expansion and drives those + the platform pairings seam. No
// direct access to inventory's tables.

import { platform, requireActionEntity } from "@cobblr/platform-contract";

let registered = false;

export function registerBricklinkHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("bricklink.disassemble-kit", async (ctx) => {
    const kitId = requireActionEntity(ctx).id;

    // 1. Find the matched catalog entry (a Rebrickable set).
    const matched = await platform().entities.walkPairings(
      ctx.orgId,
      { kind: "inventory:part", id: kitId },
      { rel: "matches", dir: "out", kind: "core-catalogs:entry" },
    );
    const match = matched[0];
    if (!match) {
      return { ok: false, error: "no_match", message: "This part isn't matched to any catalog. Match it to a Rebrickable set first." };
    }
    const setNum = match.fields.external_id as string | undefined;
    if (!setNum) return { ok: false, error: "bad_match", message: "Match is missing external_id." };

    // 2. Resolve the Lego catalogs by semantic type.
    const setsCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.set");
    const bomCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.bom");
    const partsCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.part");
    if (!bomCat) {
      return { ok: false, error: "no_bom_catalog", message: "No catalog declares semantic_type='lego.bom'. Install the rebrickable-catalogs bundle (v0.5+) and run `node scripts/seed-rebrickable.mjs --include-bom`." };
    }
    if (setsCat && match.fields.catalog_id !== setsCat.id) {
      return { ok: false, error: "not_a_set", message: "Matched catalog isn't the canonical lego.set catalog. Match this part to a Rebrickable set first." };
    }

    // 3. BOM rows for this set.
    const bomRows = await platform().catalogs.queryEntries({ orgId: ctx.orgId, catalogId: bomCat.id, payloadEq: { set_num: setNum } });
    if (bomRows.length === 0) {
      return { ok: false, error: "no_bom_rows", message: `No BOM rows for set ${setNum}. Either the set isn't in the BOM dump or your BOM data predates the set_num enrichment — re-run the seeder.` };
    }

    // 4. Part names from the parts catalog.
    const partNums = Array.from(new Set(bomRows.map((r) => String(r.payload.part_num ?? "")).filter(Boolean)));
    const partEntries = partsCat && partNums.length > 0
      ? await platform().catalogs.queryEntries({ orgId: ctx.orgId, catalogId: partsCat.id, externalIdIn: partNums })
      : [];
    const partByNum = new Map(partEntries.map((p) => [p.externalId, p]));

    // 4b. Part-category NAMES (the bin-defining shape) — resolve part_cat_id →
    // name from the lego.part-category catalog, so each spawned part carries a
    // human category ("Plate", "Wedge, Plate"). This is the signal the organize
    // planner's exact-category facet routes on (a "plates" bin vs a "wedges"
    // bin). Best-effort: no category catalog / no match → the part has none and
    // the planner falls back to name-token routing.
    const partCatCat = await platform().catalogs.findBySemanticType(ctx.orgId, "lego.part-category");
    const catIds = Array.from(
      new Set(partEntries.map((p) => String(p.payload.part_cat_id ?? "")).filter(Boolean)),
    );
    const catEntries = partCatCat && catIds.length > 0
      ? await platform().catalogs.queryEntries({ orgId: ctx.orgId, catalogId: partCatCat.id, externalIdIn: catIds })
      : [];
    const catNameById = new Map(catEntries.map((c) => [c.externalId, String(c.payload.name ?? "")]));

    // 5. Compose the child specs, then CREATE them through inventory's generic
    // bulk action (returns ids in input order so we can wire pairings).
    const specs = bomRows.map((row) => {
      const partNum = String(row.payload.part_num ?? "");
      const partEntry = partByNum.get(partNum);
      const imgUrl = typeof row.payload.img_url === "string" && row.payload.img_url.length > 0 ? row.payload.img_url : null;
      const catId = partEntry ? String(partEntry.payload.part_cat_id ?? "") : "";
      // Local BOM rows are raw (part_num/color only) and get name+category from
      // the parts / part-category catalogs. A HOSTED BOM row is already hydrated
      // (name + category on the row itself), and the local parts catalog is empty
      // — so fall back to the row's own name/category when the lookup misses.
      const rowName = typeof row.payload.name === "string" ? row.payload.name : undefined;
      const rowCategory = typeof row.payload.category === "string" ? row.payload.category : undefined;
      const category = catNameById.get(catId) || rowCategory || null;
      return {
        partEntryId: partEntry?.id ?? null,
        item: {
          name: (partEntry?.payload.name as string | undefined) ?? rowName ?? `Part ${partNum}`,
          qty: Number(row.payload.quantity ?? 1),
          unit: "each",
          image_path: imgUrl,
          fields: {
            color_id: String(row.payload.color_id ?? ""),
            is_spare: String(row.payload.is_spare ?? "").toLowerCase() === "true",
            derived_from_kit_id: kitId,
            set_num: setNum,
            part_num: partNum,
            lifecycle: "loose",
            // The bin-defining shape — the organize planner's exact-category
            // facet routes on this so the parts land in the right bins.
            ...(category ? { category } : {}),
          },
        },
      };
    });

    const created = (await platform().actions.invoke("inventory:create-items", {
      ...ctx,
      args: { items: specs.map((s) => s.item) },
    })) as { ok?: boolean; ids?: string[] };
    const ids = created?.ids ?? [];
    if (ids.length === 0) return { ok: false, error: "create_failed", message: "No parts were created." };

    // 6. Pairings: each new part → its catalog entry (matches) + back to the kit
    // (derived-from). Generic platform seam — fine to call cross-module.
    const matchesValues = ids
      .map((id, i) => {
        const partEntryId = specs[i]?.partEntryId;
        if (!partEntryId) return null;
        return { orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: id, targetKind: "core-catalogs:entry", targetId: partEntryId, relationshipKind: "matches", createdBy: ctx.userId };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const derivedFromValues = ids.map((id) => ({ orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: id, targetKind: "inventory:part", targetId: kitId, relationshipKind: "derived-from", createdBy: ctx.userId }));
    await platform().pairings.createMany(matchesValues);
    await platform().pairings.createMany(derivedFromValues);

    // 7. Mark the kit disassembled, through inventory's generic update. (The Lego
    // bundle's Sets state vocabulary is sealed / built / disassembled.)
    await platform().actions.invoke("inventory:update-item", { ...ctx, args: { id: kitId, fields: { lifecycle: "disassembled" } } });

    // 8. Hand off to the sorting planner: open the organize flow over EXACTLY the
    // parts we just spawned (the scope:"refs" door), so the user goes straight
    // from "disassembled" to "here's a plan to bin these". The web shell reads
    // result.ui and opens the registered flow; ignored where it isn't honored.
    return {
      ok: true,
      kitId,
      setNum,
      spawned: ids.length,
      message: `Spawned ${ids.length} parts from set ${setNum}.`,
      ui: {
        flow: "core-scan:organize",
        args: { scope: "refs", refs: ids.map((id) => `inventory:part::${id}`) },
      },
    };
  });
}
