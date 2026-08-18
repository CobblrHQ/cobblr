// /api/v1/orgs/:slug/modules/core-scan
//
//   POST /decode   — { code } → { outcome, fields, provenance, note? }
//
// The identifier-decoder registry's tenant endpoint: hand it a typed/scanned
// identifier (a VIN today; any registered decoder tomorrow), it dispatches to
// whichever decoder recognizes the code's SHAPE, decodes it against the
// external source, and returns a flat semantic field bag the caller maps onto a
// record by role. The guarded-auto VIN fill on the asset form calls this.
//
// Caching lives HERE (with the tenant db), not in the decoder — mirroring how
// enrich.ts owns the barcode cache while lookupBarcode stays pure. Discipline:
// a `hit`/`partial` is cached forever, a durable `miss` gets a TTL, and an
// `unavailable` (provider timeout/outage) is NEVER cached — the caller retries.
// See services/identifier-registry.ts + docs/design-decisions/vin-decode.md §6.

import { Router } from "express";
import { z } from "zod";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { findDecoder } from "../services/identifier-registry.js";
import { registerBuiltinDecoders } from "../services/vin-decode.js";
import { readDecodeCache, writeDecodeCache, decodeCacheKey } from "../services/decode-cache.js";

// Register the built-in decoders once, at router construction (idempotent).
registerBuiltinDecoders();

export const decodeRouter = Router({ mergeParams: true });

const DecodeBody = z.object({
  code: z.string().min(1).max(200),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
decodeRouter.post(
  "/decode",
  asyncHandler(async (req, res) => {
    // Decode feeds the entity EDIT form, which is an editor action → member+.
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = DecodeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);

    const code = parsed.data.code.trim();
    const decoder = findDecoder(code);
    // No decoder recognizes the code's shape → nothing to decode. This is NOT a
    // decode miss (the code was never claimed); return a bare miss with no
    // provenance so the client shows the quiet "couldn't decode" hint.
    if (!decoder) {
      res.json({ outcome: "miss", fields: {}, provenance: null });
      return;
    }

    const cacheKey = decodeCacheKey(code);
    const db = tenantDb(req);

    const cached = await readDecodeCache(db, decoder.id, cacheKey);
    if (cached) {
      res.json({
        outcome: cached.outcome,
        fields: cached.fields,
        provenance: cached.provenance,
        note: cached.note,
      });
      return;
    }

    const result = await decoder.decode(code);
    await writeDecodeCache(db, decoder.id, cacheKey, result);
    res.json({
      outcome: result.outcome,
      fields: result.fields,
      provenance: result.provenance,
      note: result.note,
    });
  }),
);
