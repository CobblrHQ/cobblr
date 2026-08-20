// In-process entity writer for machines:machine.
//
// Lets cross-module writers (the core-integrations sync engine, mirroring an
// external system) create/update/delete machines with NO HTTP
// loopback or user token — the SAME way core-locations exposes its kind. The
// machines module opts into being a sync TARGET by registering this; the source
// side stays pure declarative data. Fires the module's own events so views,
// wires, and the instance counters stay consistent with the HTTP path.

import { platform, restoreRow, snapshotRow } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";

let registered = false;

export function registerMachinesWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("machines:machine", {
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const inserted = await db
        .insertInto("machines_machines")
        .values({
          name: String(fields.name ?? "Untitled"),
          short_name: asStr(fields.short_name),
          family: asStr(fields.family),
          type: asStr(fields.type),
          manufacturer: asStr(fields.manufacturer),
          serial_number: asStr(fields.serial_number),
          state: asStr(fields.state) ?? "functional",
          image_path: asStr(fields.image_path),
          notes: asStr(fields.notes),
          // Was missing entirely — the writer silently dropped location on
          // create/update (core-mobility return-home never worked for machines,
          // and placement's location_id sync needs it).
          location_id: asStr(fields.location_id),
          ...(asInt(fields.excitement) !== null ? { excitement: asInt(fields.excitement)! } : {}),
          ...(asInt(fields.quantity) !== null ? { quantity: asInt(fields.quantity)! } : {}),
          // Land in the requested instance (e.g. "3d-printers") so it shows under
          // that nav entry, not generic Machines. Default keeps the base instance.
          ...(asStr(fields.instance) ? { instance: asStr(fields.instance)! } : {}),
          metadata: sql`${JSON.stringify(fields.metadata ?? {})}::jsonb` as never,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      void platform().events.emit("machines.machine.created", { orgId, machineId: inserted.id });
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (fields.name !== undefined) patch.name = String(fields.name);
      if (fields.short_name !== undefined) patch.short_name = asStr(fields.short_name);
      if (fields.family !== undefined) patch.family = asStr(fields.family);
      if (fields.type !== undefined) patch.type = asStr(fields.type);
      if (fields.manufacturer !== undefined) patch.manufacturer = asStr(fields.manufacturer);
      if (fields.serial_number !== undefined) patch.serial_number = asStr(fields.serial_number);
      if (fields.state !== undefined) patch.state = asStr(fields.state) ?? "functional";
      if (fields.image_path !== undefined) patch.image_path = asStr(fields.image_path);
      if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
      if (fields.location_id !== undefined) patch.location_id = asStr(fields.location_id);
      if (fields.excitement !== undefined && asInt(fields.excitement) !== null) patch.excitement = asInt(fields.excitement);
      if (fields.quantity !== undefined && asInt(fields.quantity) !== null) patch.quantity = asInt(fields.quantity);
      if (fields.metadata !== undefined) {
        patch.metadata = sql`${JSON.stringify(fields.metadata ?? {})}::jsonb`;
      }
      // Re-target the instance on update too, so a section that gains a
      // targetInstance MOVES already-imported machines into it on the next sync.
      if (asStr(fields.instance)) patch.instance = asStr(fields.instance);
      await db.updateTable("machines_machines").set(patch as never).where("id", "=", id).execute();
      void platform().events.emit("machines.machine.updated", { orgId, machineId: id });
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      await db.deleteFrom("machines_machines").where("id", "=", id).execute();
      void platform().events.emit("machines.machine.deleted", { orgId, machineId: id });
    },

    /** Put the row back exactly as it was, id and all (EntityWriter.restore).
     *  Not a create: no name-clash rule, no re-derived id, no new row for
     *  everything that pointed at the old one to miss. */
    async restore(orgId, image) {
      await restoreRow(await platform().tenants.getDb(orgId), "machines_machines", image);
    },

    /** Every column of one row — the state a change ledger keeps so an undo
     *  has something real to put back (EntityWriter.snapshot). */
    async snapshot(orgId, id) {
      return snapshotRow(await platform().tenants.getDb(orgId), "machines_machines", id);
    },

    // Existing machines, for the import preview's name-merge.
    async listForMatch(orgId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const rows = await db.selectFrom("machines_machines").select(["id", "name"]).execute();
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },

    // Current fields of one machine — for the import preview's both-sides diff.
    async read(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const row = await db
        .selectFrom("machines_machines")
        .select(["name", "short_name", "family", "type", "manufacturer", "serial_number", "state", "image_path", "notes", "metadata"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        name: row.name,
        short_name: row.short_name,
        family: row.family,
        type: row.type,
        manufacturer: row.manufacturer,
        serial_number: row.serial_number,
        state: row.state,
        image_path: row.image_path,
        notes: row.notes,
        metadata: row.metadata,
      };
    },
  });
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
