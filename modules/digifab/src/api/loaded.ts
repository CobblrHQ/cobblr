// The spools loaded on a printer (loaded-spools.ts): read, load, unload, and
// how many filament slots the printer has. Mounted at /loaded.
//
//   GET  /loaded/:machineId            → { slots, loaded: [{ slot, thing }] }
//   PUT  /loaded/:machineId/slots      { slots }       a plain printer 1, an AMS 4
//   POST /loaded/:machineId/load       { part_id, slot? } the spool goes in; the
//                                      one it replaces goes back to its shelf
//   POST /loaded/:machineId/unload     { slot }         back to its shelf

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { loadedOn, MACHINE_KIND } from "../loaded-spools.js";

export const loadedRouter = Router({ mergeParams: true });

const THING_KIND = "inventory:part";
const VIA = "loaded on a printer";

async function slotsOf(db: ReturnType<typeof tenantDb>, machineId: string): Promise<number> {
  const row = await db.selectFrom("digifab_machine_slots").select(["slots"]).where("machine_id", "=", machineId).executeTakeFirst();
  return row?.slots ?? 1;
}

async function view(orgId: string, db: ReturnType<typeof tenantDb>, machineId: string) {
  const [slots, loaded] = await Promise.all([slotsOf(db, machineId), loadedOn(orgId, machineId)]);
  const things = loaded.length ? await platform().entities.lookupMany(orgId, loaded.map((l) => ({ kind: THING_KIND, id: l.partId }))) : [];
  const byId = new Map(things.map((t) => [t.id, t]));
  return {
    slots: Math.max(slots, ...loaded.map((l) => Number(l.slot) || 0)),
    loaded: loaded.map((l) => ({ slot: l.slot, thing: byId.get(l.partId) ?? { id: l.partId, kind: THING_KIND, title: "(removed)" } })),
  };
}

loadedRouter.get(
  "/:machineId",
  asyncHandler(async (req, res) => {
    res.json(await view(tenantContext(req).org.id, tenantDb(req), String(req.params.machineId)));
  }),
);

const Slots = z.object({ slots: z.number().int().min(1).max(64) });

// AI-REACH: exempt (a printer's physical slot count, set once on the printer's page)
loadedRouter.put(
  "/:machineId/slots",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Slots.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const machineId = String(req.params.machineId);
    const db = tenantDb(req);
    await db
      .insertInto("digifab_machine_slots")
      .values({ machine_id: machineId, slots: parsed.data.slots })
      .onConflict((oc) => oc.column("machine_id").doUpdateSet({ slots: parsed.data.slots, updated_at: new Date() }))
      .execute();
    res.json(await view(tenantContext(req).org.id, db, machineId));
  }),
);

const Load = z.object({ part_id: z.string().uuid(), slot: z.string().regex(/^\d{1,2}$/).optional() });

// AI-REACH: action core-placement:place
loadedRouter.post(
  "/:machineId/load",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Load.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const machineId = String(req.params.machineId);
    const db = tenantDb(req);
    // Only a thing kept in a collection loads (a printer's label scanned on
    // another printer's page is not a spool).
    const thing = await platform().entities.lookup(orgId, THING_KIND, parsed.data.part_id).catch(() => null);
    if (!thing) {
      res.status(404).json({ error: { code: "not_a_thing", message: "That is not something kept in a collection, so it cannot be loaded." } });
      return;
    }
    const now = await loadedOn(orgId, machineId);
    const already = now.find((l) => l.partId === parsed.data.part_id);
    // No slot named: the slot it is already in, else the first empty one, else 1.
    const slots = await slotsOf(db, machineId);
    let slot = parsed.data.slot ?? already?.slot;
    if (!slot) {
      const taken = new Set(now.map((l) => l.slot));
      slot = Array.from({ length: slots }, (_, i) => String(i + 1)).find((s) => !taken.has(s)) ?? "1";
    }
    if (Number(slot) > slots) {
      res.status(400).json({ error: { code: "no_such_slot", message: `This printer has ${slots} slot${slots === 1 ? "" : "s"}.` } });
      return;
    }
    try {
      const done = await platform().placement.place({
        orgId,
        containee: { kind: THING_KIND, id: parsed.data.part_id },
        container: { kind: MACHINE_KIND, id: machineId },
        slot,
        oneToASlot: true,
        placedBy: sessionUser(req)?.id ?? null,
        via: VIA,
      });
      const back = done?.displaced ?? [];
      const out = await view(orgId, db, machineId);
      const returned = back.length ? await platform().entities.lookupMany(orgId, back.map((b) => ({ kind: b.kind, id: b.id }))) : [];
      const to = back.length ? await platform().entities.lookupMany(orgId, back.flatMap((b) => (b.to ? [b.to] : []))) : [];
      res.json({ ...out, slot, returned: back.map((b, i) => ({ thing: returned[i] ?? { id: b.id }, to: b.to ? (to.find((t) => t.id === b.to!.id) ?? null) : null })) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(/placement:/.test(message) ? 422 : 500).json({ error: { code: "cannot_load", message: message.replace(/^placement:\s*/, "") } });
    }
  }),
);

const Unload = z.object({ slot: z.string().regex(/^\d{1,2}$/) });

// AI-REACH: action core-placement:return-home
loadedRouter.post(
  "/:machineId/unload",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Unload.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const machineId = String(req.params.machineId);
    const here = (await loadedOn(orgId, machineId)).find((l) => l.slot === parsed.data.slot);
    if (!here) {
      res.status(404).json({ error: { code: "slot_empty", message: `Nothing is loaded in slot ${parsed.data.slot}.` } });
      return;
    }
    const to = await platform().placement.returnHome({ orgId, containee: { kind: THING_KIND, id: here.partId }, placedBy: sessionUser(req)?.id ?? null, via: VIA });
    const place = to ? ((await platform().entities.lookupMany(orgId, [to]))[0] ?? null) : null;
    res.json({ ...(await view(orgId, tenantDb(req), machineId)), to: place });
  }),
);
