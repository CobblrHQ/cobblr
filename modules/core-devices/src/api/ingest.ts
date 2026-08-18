// /api/v1/orgs/:slug/modules/core-devices/ingest — INBOUND device events.
//
// The chip→Cobblr direction (moved here from digifab — it's general device I/O,
// not fabrication). An edge device POSTs a reading/scan/count; we (1) emit a
// platform event a power-user wire can consume, and (2) resolve the device→entity
// link and apply it (the link IS the config — the common case needs no wire). The
// device never writes an entity; the entity-owning module's action does. See
// the edge firmware ESP32 spec, §4.5.
//
// Auth (v1): the normal workspace Bearer (a Cobblr API token pasted into the
// chip's `ingest.token`). A narrow per-connection ingest token is the documented
// hardening follow-up. (Connection-existence is not checked here yet — connections
// still live in digifab until a later extraction PR; the device only emits, and a
// bogus connection simply matches no link. The auth is the gate.)

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { applyToLinkedEntity, type DevicePayload } from "./action-handlers.js";

export const ingestRouter = Router({ mergeParams: true });

const IngestBody = z.object({
  /** The device's connection id (matches a device→entity link's connection_id). */
  connection: z.string().uuid(),
  /** The logical device id on the chip ("scale", "badge", "beam"). */
  device: z.string().min(1).max(128),
  kind: z.enum(["reading", "scanned", "counted"]),
  value: z.number().optional(),
  unit: z.string().max(32).optional(),
  tag: z.string().max(256).optional(),
  count: z.number().int().optional(),
  delta: z.number().int().optional(),
  /** When the device sampled it (ISO-8601); defaults to receipt time. */
  at: z.string().datetime().optional(),
});

const EVENT_BY_KIND = {
  reading: "core-devices.device.reading",
  scanned: "core-devices.device.scanned",
  counted: "core-devices.device.counted",
} as const;

// AI-REACH: the device wire; a sensor or a bridge posts readings here, not a person
ingestRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    // A device acts on the workspace's behalf — editors+ (not guests).
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    const ctx = tenantContext(req);

    const base = {
      orgId: ctx.org.id,
      connection: d.connection,
      device: d.device,
      at: d.at ?? new Date().toISOString(),
    };
    const payload: DevicePayload & { orgId: string; at: string; unit?: string | null } =
      d.kind === "reading"
        ? { ...base, value: d.value ?? null, unit: d.unit ?? null }
        : d.kind === "scanned"
          ? { ...base, tag: d.tag ?? null }
          : { ...base, count: d.count ?? null, delta: d.delta ?? null };
    const event = EVENT_BY_KIND[d.kind];

    // Emit for power-user wires, then resolve + apply the link (the common case).
    await platform().events.emit(event, payload);
    const applied = await applyToLinkedEntity(ctx.org.id, payload);
    res.status(202).json({ ok: true, event, applied });
  }),
);
