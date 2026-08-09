// POST /api/v1/orgs/:slug/modules/core-scan/entity-image
// Automatic web image search for an entity (e.g. a 3D printer): search → fetch →
// store → set image_path. Returns the resolved { image_path } (or null) so the
// caller can refetch and show the photo LIVE while the detail modal is open — no
// refresh needed. The user does nothing.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { bearer, tenantContext } from "../db.js";
import { enrichEntityImage } from "../services/entity-image.js";
import { searchImages, rankImageOptions, deriveImageQuery } from "../services/ddg-images.js";
import { needsImage } from "../services/needs-image.js";

export const entityImageRouter = Router({ mergeParams: true });

const Body = z.object({
  entity_kind: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(100),
  /** Optional: omit it and the phrase is DERIVED from the entity, the same way
   *  the picker and the scan inbox derive it. Callers should omit rather than
   *  hand-build — a hand-built phrase is how "Auto" and "search the web" ended
   *  up finding different things for the same book. */
  query: z.string().min(2).max(200).optional(),
  instance: z.string().max(80).nullable().optional(),
  /** A specific web-image url the user picked (skips auto-search). */
  image_url: z.string().url().max(2000).optional(),
});

/** The image-search phrase for an entity, derived server-side from its own
 *  name / brand / fields. Shared by the options strip and the auto-fetch so
 *  they can never search differently for the same thing. */
async function derivedQueryFor(
  orgId: string,
  kind: string,
  id: string,
  override?: string | null,
): Promise<{ query: string | null; brand: string | null; resolved: boolean }> {
  const e = await platform().entities.lookup(orgId, kind, id).catch(() => null);
  // `resolved` separates "this kind has no single-entity resolver" (a wiring
  // gap) from "resolved fine but there's nothing to search for" (a data gap).
  if (!e) return { query: (override ?? "").trim() || null, brand: null, resolved: false };
  const fields = (e.fields ?? {}) as Record<string, unknown>;
  // The custom-field bag lives under `metadata` for the physical kinds; merge
  // it so a declared author/director/colour sharpens the phrase just like a
  // native column does.
  const meta = (fields.metadata ?? {}) as Record<string, unknown>;
  const merged = { ...meta, ...fields };
  const brand = typeof merged.manufacturer === "string" ? (merged.manufacturer as string) : null;
  return {
    query: deriveImageQuery({ name: e.title, brand, fields: merged, override: override ?? null }),
    brand,
    resolved: true,
  };
}

// GET /image-options — the universal "search the web for a photo" strip, for
// ANY entity. Three ways to say what to search, in precedence order:
//   entity_kind + entity_id → the phrase is DERIVED from that entity exactly
//     the way the scan inbox derives it (name + brand + its own fields: an
//     author + media word, a colour). This is the one every caller should use:
//     it is why a book searches "… Laura Ingalls Wilder book" on its record
//     page and not a bare title that returns farm scenery.
//   q → a literal phrase (a user-typed term, or a caller with no entity yet).
//     When BOTH are given, q wins — the user asked for exactly that.
// Same pool size + catalog-quality ranking in every case.
const OptionsQuery = z.object({
  q: z.string().max(200).optional(),
  brand: z.string().max(120).optional(),
  entity_kind: z.string().max(64).optional(),
  entity_id: z.string().max(100).optional(),
});
entityImageRouter.get(
  "/image-options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OptionsQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const { q, brand, entity_kind, entity_id } = parsed.data;

    let query: string | null = null;
    let rankBrand: string | null = brand ?? null;
    if (entity_kind && entity_id) {
      const derived = await derivedQueryFor(tenantContext(req).org.id, entity_kind, entity_id, q ?? null);
      query = derived.query;
      rankBrand = rankBrand ?? derived.brand;
    }
    if (!query) query = (q ?? "").trim() || null;
    // Below the useful-search floor (or a junk name) → no options, rather than
    // a strip of nonsense results.
    if (!query || query.length < 2) {
      res.json({ items: [] });
      return;
    }
    const pool = await searchImages(query, 24).catch(() => []);
    const items = rankImageOptions(pool, rankBrand, query).slice(0, 12);
    res.json({ items, query });
  }),
);

entityImageRouter.post(
  "/entity-image",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) return void res.status(401).json({ error: { code: "no_auth", message: "missing bearer" } });
    const slug = req.params.slug;
    if (!slug) return void res.status(400).json({ error: { code: "no_slug", message: "missing slug" } });
    // No explicit query (and no picked url to skip the search)? Derive the
    // phrase from the entity — the SAME derivation the options strip uses, so
    // "Auto" and "search the web" can't disagree about what this thing is.
    let query = parsed.data.query ?? "";
    if (!query.trim() && !parsed.data.image_url) {
      const derived = await derivedQueryFor(
        tenantContext(req).org.id,
        parsed.data.entity_kind,
        parsed.data.entity_id,
      );
      if (!derived.query) {
        // Nothing searchable (a junk/empty name) — say so instead of fetching
        // whatever a bare "Unknown Item" search returns.
        res.json({ image_path: null });
        return;
      }
      query = derived.query;
    }
    // Await the search + download + set so the caller gets the resolved
    // image_path and can show it live. Bounded (~8s fetch + the search), and
    // best-effort: enrichEntityImage never throws (null on any failure).
    const image_path = await enrichEntityImage({
      orgId: tenantContext(req).org.id,
      orgSlug: slug,
      bearer: token,
      entityKind: parsed.data.entity_kind,
      entityId: parsed.data.entity_id,
      query,
      instance: parsed.data.instance ?? null,
      imageUrl: parsed.data.image_url ?? null,
    });
    res.json({ image_path });
  }),
);

// POST /entity-image/backfill — fill in the missing pictures for a whole
// collection in one press, instead of opening each record and clicking Auto.
// Generic over any kind/instance: it lists the collection through the platform
// list seam, takes the ones with no stored image, and runs the SAME derived
// auto-fetch a single record's "Auto" runs.
//
// Detached per record (each is a web search + download), so the request returns
// immediately with how many it started; the pictures appear as they land and
// the client refetches. Idempotent: a record that already has a picture is
// never touched, so pressing it twice is safe and picks up where it left off.
const BackfillBody = z.object({
  entity_kind: z.string().min(1).max(64),
  instance: z.string().max(80).nullable().optional(),
  /** Bounded per press — this spends a web search + download per record. */
  limit: z.number().int().min(1).max(50).optional(),
});
entityImageRouter.post(
  "/entity-image/backfill",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BackfillBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const token = bearer(req);
    if (!token) return void res.status(401).json({ error: { code: "no_auth", message: "missing bearer" } });
    const slug = req.params.slug;
    if (!slug) return void res.status(400).json({ error: { code: "no_slug", message: "missing slug" } });
    const orgId = tenantContext(req).org.id;
    const { entity_kind, instance } = parsed.data;
    const limit = parsed.data.limit ?? 25;

    // A generous read window so a big shelf's missing few are found, then the
    // WRITE side is what's capped.
    const listed = await platform()
      .entities.list(orgId, entity_kind, { limit: 500 })
      .catch(() => ({ items: [] as Array<{ id: string; title: string; image_path?: string }> }));
    const targets = needsImage(listed.items, limit);
    const missingTotal = listed.items.filter(
      (i) => !(typeof i.image_path === "string" && i.image_path.trim()),
    ).length;

    // Distinguish WHY a record was skipped. Collapsing these into one count
    // produced a message that blamed the data ("these need a name first") for
    // what was actually a missing resolver registration — the wrong thing to
    // tell someone whose records plainly had names (reported 2026-07-18).
    let started = 0;
    let unresolved = 0; // entities.lookup returned null (a module wiring gap)
    let unnamed = 0; // resolved, but nothing searchable to derive from
    for (const t of targets) {
      const derived = await derivedQueryFor(orgId, entity_kind, t.id);
      if (!derived.query) {
        if (derived.resolved) unnamed++;
        else unresolved++;
        continue;
      }
      started++;
      void enrichEntityImage({
        orgId,
        orgSlug: slug,
        bearer: token,
        entityKind: entity_kind,
        entityId: t.id,
        query: derived.query,
        instance: instance ?? null,
        imageUrl: null,
      }).catch((err) => console.error("[core-scan] cover backfill failed:", (err as Error).message));
    }
    res.json({
      missing: missingTotal,
      started,
      remaining: Math.max(0, missingTotal - started),
      unnamed,
      unresolved,
    });
  }),
);
