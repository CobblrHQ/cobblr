// In-process entity writer for machines:machine.
//
// Lets cross-module writers (the core-integrations sync engine, mirroring an
// external system like companion app) create/update/delete machines with NO HTTP
// loopback or user token — the SAME way core-locations exposes its kind. The
// machines module opts into being a sync TARGET by registering this; the source
// side stays pure declarative data. Fires the module's own events so views,
// wires, and the instance counters stay consistent with the HTTP path.

import { platform } from "@cobblr/platform-contract";
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
          state: asStr(fields.state) ?? "functional",
          image_path: asStr(fields.image_path),
          notes: asStr(fields.notes),
          ...(asInt(fields.excitement) !== null ? { excitement: asInt(fields.excitement)! } : {}),
          ...(asInt(fields.quantity) !== null ? { quantity: asInt(fields.quantity)! } : {}),
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
      if (fields.state !== undefined) patch.state = asStr(fields.state) ?? "functional";
      if (fields.image_path !== undefined) patch.image_path = asStr(fields.image_path);
      if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
      if (fields.excitement !== undefined && asInt(fields.excitement) !== null) patch.excitement = asInt(fields.excitement);
      if (fields.quantity !== undefined && asInt(fields.quantity) !== null) patch.quantity = asInt(fields.quantity);
      if (fields.metadata !== undefined) {
        patch.metadata = sql`${JSON.stringify(fields.metadata ?? {})}::jsonb`;
      }
      await db.updateTable("machines_machines").set(patch as never).where("id", "=", id).execute();
      void platform().events.emit("machines.machine.updated", { orgId, machineId: id });
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      await db.deleteFrom("machines_machines").where("id", "=", id).execute();
      void platform().events.emit("machines.machine.deleted", { orgId, machineId: id });
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
        .select(["name", "short_name", "family", "type", "manufacturer", "state", "image_path", "notes", "metadata"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        name: row.name,
        short_name: row.short_name,
        family: row.family,
        type: row.type,
        manufacturer: row.manufacturer,
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
