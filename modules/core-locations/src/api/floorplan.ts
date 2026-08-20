// Floor plan — the third lens on the locations hierarchy: the same records
// drawn where they physically stand. See docs/design-decisions/location-floor-plan.md.
//
// All geometry lives under metadata.floorplan (mm integers, origin top-left,
// x → right, y → down). This file owns:
//   • the zod schemas (also imported by the seed eval script),
//   • POST /locations/:id/floorplan/seed — describe-to-plan: an AI drafts the
//     room dims + walls (+ door openings) + zone regions from a prose
//     description. dry_run returns the validated draft without writing —
//     that's the UI preview path AND the eval path.
//
// The seed NEVER creates containers — only the room's own floorplan and its
// named zones (child areas). Items are placed by hand or already exist.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

// ─────────────────────────── schemas ────────────────────────────────

const mm = z.number().int().min(0).max(1_000_000); // 1 km cap: sanity, not CAD

export const FloorplanOpening = z.object({
  /** Offset of the opening's start along the wall segment, from (x1,y1). */
  at_mm: mm,
  /** Width of the cutout. A door is a hole — nothing more. */
  w_mm: mm.refine((v) => v > 0, "opening width must be > 0"),
});

export const FloorplanWall = z
  .object({
    x1: mm,
    y1: mm,
    x2: mm,
    y2: mm,
    openings: z.array(FloorplanOpening).max(20).optional(),
  })
  .refine((w) => w.x1 === w.x2 || w.y1 === w.y2, {
    message: "walls are axis-aligned segments (x1===x2 or y1===y2)",
  })
  .refine((w) => !(w.x1 === w.x2 && w.y1 === w.y2), {
    message: "wall has zero length",
  });

export const RoomFloorplan = z.object({
  w_mm: mm.refine((v) => v > 0),
  d_mm: mm.refine((v) => v > 0),
  /** The unit the user expressed dimensions in — echoed back by the edit UI.
   *  Geometry itself is ALWAYS mm. */
  unit: z.enum(["ft", "in", "m", "cm", "mm"]).optional(),
  /** Which way this layout looks. "plan" = top-down (a room: w × depth).
   *  "front" = elevation (a toolbox face: w × height — its drawers lay out
   *  in this view, partial-width drawers at true scale). Same geometry, same
   *  editor; only the second axis's meaning and edit-mode labels change. */
  view: z.enum(["plan", "front"]).optional(),
  /** Snap pitch for this layout, mm — 42 for exact Gridfinity, anything for
   *  "smallest unit = 1 square". Placement quantizes to it. */
  grid_mm: z.number().int().min(5).max(1000).optional(),
  walls: z.array(FloorplanWall).max(50).optional(),
});

export const ChildPlacement = z.object({
  x_mm: mm,
  y_mm: mm,
  w_mm: mm.refine((v) => v > 0),
  d_mm: mm.refine((v) => v > 0),
  /** Renders as a thin strip against a wall (ladder hooks). Cosmetic. */
  wall_mounted: z.boolean().optional(),
});

/** What the seed model must return. Zones are REGIONS (invisible on the
 *  day-to-day view; faint toggleable labels; drop-targets for reparenting).
 *  Placements are the FURNITURE the description names (racks, toolboxes,
 *  benches) — drafted with plausible true-scale rects; on apply they only
 *  ever attach to EXISTING children matched by name, never create. */
export const SeedDraft = z.object({
  room: RoomFloorplan,
  zones: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        rect: z.object({ x_mm: mm, y_mm: mm, w_mm: mm, d_mm: mm }),
      }),
    )
    .max(24)
    .default([]),
  placements: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        rect: z.object({ x_mm: mm, y_mm: mm, w_mm: mm, d_mm: mm }),
      }),
    )
    .max(60)
    .default([]),
});
export type SeedDraftT = z.infer<typeof SeedDraft>;

// ───────────────────────── seed prompt ──────────────────────────────

/** Teach the model the schema + the conventions, then hand it the user's
 *  prose. Strict JSON out; validated by SeedDraft; one repair retry. */
export function buildSeedPrompt(description: string, roomName: string): string {
  return `You convert a prose description of a room/space into a floor-plan JSON draft.

COORDINATE SYSTEM
- Millimeters, integers only. Origin is the TOP-LEFT corner of the room.
- x increases to the RIGHT (the room's width), y increases DOWNWARD (its depth).
- "wide" → w_mm (x axis). "deep" → d_mm (y axis).
- Convert units: 1 ft = 304.8 mm, 1 in = 25.4 mm, 1 m = 1000 mm. Round to integers.

OUTPUT — exactly this JSON shape, nothing else, no markdown fences:
{
  "room": {
    "w_mm": <int>, "d_mm": <int>,
    "unit": "<ft|in|m|cm|mm — the unit the description mostly used>",
    "walls": [
      { "x1": <int>, "y1": <int>, "x2": <int>, "y2": <int>,
        "openings": [ { "at_mm": <int>, "w_mm": <int> } ] }
    ]
  },
  "zones": [ { "name": "<string>", "rect": { "x_mm":, "y_mm":, "w_mm":, "d_mm": } } ],
  "placements": [ { "name": "<string>", "rect": { "x_mm":, "y_mm":, "w_mm":, "d_mm": } } ]
}

RULES
- Walls are INTERIOR partitions only — never draw the room's outer boundary
  (the room rect IS the boundary). Walls are axis-aligned: x1===x2 (vertical)
  or y1===y2 (horizontal).
- A doorway/opening in a wall is an entry in that wall's "openings": at_mm is
  the offset along the segment from (x1,y1); w_mm is the cutout width. If the
  description implies people pass between spaces but gives no door size, use a
  sensible ~900 mm opening placed plausibly.
- A partition that doesn't reach the front of the room should stop short
  (e.g. run from y=0 to ~70% of d_mm) unless the description says otherwise.
- ZONES are named regions of floor (bays, corners, halves). Emit one per zone
  the description names, tiling the space they describe. Zones may share edges
  with walls. Do NOT invent zones that aren't described. Do NOT emit zones for
  furniture/containers (racks, toolboxes, benches are NOT zones).
- PLACEMENTS are the furniture/containers the description NAMES standing in
  the space (racks, toolboxes, benches, wall hooks). One per named object,
  short name copied from the description, a plausible true-scale rect
  (a workbench ~1500×600 mm, a rolling toolbox ~700×500 mm, wall hooks a thin
  ~1200×150 mm strip), positioned as described — against the named wall or
  inside the named zone, never overlapping walls, never outside the room.
  Do NOT invent objects that aren't named. No objects described → [].
- If the description leaves something ambiguous, choose the simplest reading;
  never ask questions; never add commentary.

The room is called "${roomName}".

DESCRIPTION:
${description}`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

/** Run the model → parse → validate, with ONE repair retry that feeds the
 *  validation errors back (the core-authoring pattern). Exported for the
 *  eval script so the eval exercises exactly the production path. */
export async function runFloorplanSeed(opts: {
  orgId: string;
  roomId: string;
  roomName: string;
  description: string;
  userId: string | null;
}): Promise<SeedDraftT> {
  let prompt = buildSeedPrompt(opts.description, opts.roomName);
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await platform().ai.invoke({
      orgId: opts.orgId,
      capability: "chat",
      input: { messages: [{ role: "user", content: prompt }] },
      source: { kind: "core-locations:floorplan-seed", id: opts.roomId },
      userId: opts.userId,
    });
    const result = r.result as { content?: string; text?: string } | string;
    const text = typeof result === "string" ? result : (result?.content ?? result?.text ?? "");
    try {
      const parsed = SeedDraft.safeParse(extractJson(text));
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    prompt = `${buildSeedPrompt(opts.description, opts.roomName)}

Your previous answer failed validation: ${lastErr}
Return ONLY the corrected JSON.`;
  }
  throw new Error(`floorplan seed failed validation after retry: ${lastErr}`);
}

// ─────────────────────────── the route ──────────────────────────────

export const floorplanRouter = Router({ mergeParams: true });

const SeedBody = z.object({
  description: z.string().min(10).max(8_000),
  dry_run: z.boolean().optional(),
});

// AI-REACH: seeds a floor plan from a description; it is the AI describe button on the plan editor, already an AI capability with its own preview
floorplanRouter.post(
  "/:id/floorplan/seed",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = SeedBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const room = await db
      .selectFrom("core_locations_locations")
      .select(["id", "name", "kind", "depth", "metadata"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!room) {
      res.status(404).json({ error: { code: "not_found", message: "location not found" } });
      return;
    }

    let draft: SeedDraftT;
    try {
      draft = await runFloorplanSeed({
        orgId: ctx.org.id,
        roomId: id,
        roomName: room.name,
        description: parsed.data.description,
        userId: sessionUser(req).id ?? null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const noAi =
        msg.includes("no provider") || msg.includes("not entitled") || msg.includes("not available");
      res.status(noAi ? 409 : 502).json({
        error: {
          code: noAi ? "no_ai_provider" : "seed_failed",
          message: noAi
            ? "No AI provider resolves for this workspace — draw the plan by hand, or connect AI."
            : msg,
        },
      });
      return;
    }

    if (parsed.data.dry_run) {
      res.json({ draft, applied: false });
      return;
    }

    // Apply: the room's floorplan (metadata-merged), then each named zone —
    // matched to an existing child AREA by name (case-insensitive) or created.
    const now = new Date();
    await db
      .updateTable("core_locations_locations")
      .set({
        metadata: sql`${JSON.stringify({
          ...((room.metadata as Record<string, unknown>) ?? {}),
          floorplan: draft.room,
        })}::jsonb` as never,
        updated_at: now,
      })
      .where("id", "=", id)
      .execute();

    const children = await db
      .selectFrom("core_locations_locations")
      .select(["id", "name", "metadata"])
      .where("parent_id", "=", id)
      .execute();
    const byName = new Map(children.map((c) => [c.name.trim().toLowerCase(), c] as const));
    const zoneIds: Array<{ name: string; id: string; created: boolean }> = [];
    for (const zone of draft.zones) {
      const existing = byName.get(zone.name.trim().toLowerCase());
      if (existing) {
        await db
          .updateTable("core_locations_locations")
          .set({
            metadata: sql`${JSON.stringify({
              ...((existing.metadata as Record<string, unknown>) ?? {}),
              floorplan: zone.rect,
            })}::jsonb` as never,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
        zoneIds.push({ name: zone.name, id: existing.id, created: false });
        // SIBLING-DUP-OK: this path already reuses a zone of the same name
        // instead of adding one (that is what created:false above means), so a
        // duplicate cannot come out of it.
      } else {
        const inserted = await db
          .insertInto("core_locations_locations")
          .values({
            name: zone.name,
            short_name: null,
            parent_id: id,
            depth: room.depth + 1,
            kind: "area",
            metadata: sql`${JSON.stringify({ floorplan: zone.rect })}::jsonb` as never,
            description: null,
            notes: null,
            image_path: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        zoneIds.push({ name: zone.name, id: inserted.id, created: true });
        void platform().events.emit("core-locations.location.created", {
          orgId: ctx.org.id,
          locationId: inserted.id,
        });
      }
    }
    // Placements: attach drafted rects to EXISTING children matched by name
    // (exact case-insensitive, else a ≥4-char substring either direction so
    // "grey metal rack" finds a child named "Metal rack"). Never creates —
    // an unmatched name is reported and skipped; existing placements are
    // never overwritten (the user's own positioning wins over a draft).
    const norm = (s: string) => s.trim().toLowerCase();
    const matchChild = (name: string) => {
      const n = norm(name);
      const exact = children.find((c) => norm(c.name) === n);
      if (exact) return exact;
      if (n.length < 4) return undefined;
      return children.find((c) => {
        const cn = norm(c.name);
        return cn.length >= 4 && (cn.includes(n) || n.includes(cn));
      });
    };
    const placementResults: Array<{ name: string; id: string | null; applied: boolean }> = [];
    for (const p of draft.placements) {
      const child = matchChild(p.name);
      if (!child) {
        placementResults.push({ name: p.name, id: null, applied: false });
        continue;
      }
      const meta = (child.metadata as Record<string, unknown>) ?? {};
      if (meta.floorplan && typeof meta.floorplan === "object" && (meta.floorplan as { x_mm?: unknown }).x_mm !== undefined) {
        placementResults.push({ name: p.name, id: child.id, applied: false });
        continue;
      }
      await db
        .updateTable("core_locations_locations")
        .set({
          // Overlay just the floorplan rect, DB-side — a location's metadata holds
          // more than the floorplan, and the snapshot rewrite dropped the rest.
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ floorplan: p.rect })}::jsonb` as never,
          updated_at: now,
        })
        .where("id", "=", child.id)
        .execute();
      placementResults.push({ name: p.name, id: child.id, applied: true });
    }

    void platform().events.emit("core-locations.location.updated", {
      orgId: ctx.org.id,
      locationId: id,
    });

    res.json({ draft, applied: true, zones: zoneIds, placements: placementResults });
  }),
);
