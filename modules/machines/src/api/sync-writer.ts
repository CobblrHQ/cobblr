// In-process entity writer for machines:machine.
//
// Lets cross-module writers (the core-integrations sync engine, mirroring an
// external system) create/update/delete machines with NO HTTP
// loopback or user token — the SAME way core-locations exposes its kind. The
// machines module opts into being a sync TARGET by registering this; the source
// side stays pure declarative data. Fires the module's own events so views,
// wires, and the instance counters stay consistent with the HTTP path.

import { adoptAxisValuesIntoField, findRowIdByKey, mergeRowMetadata, platform, restoreRow, snapshotRow, snapshotRowTree, restoreRowTree, rowVersionOf, updateRowAt } from "@cobblr/platform-contract";
import { DISPOSITION_LABELS } from "@cobblr/platform-contract/disposition";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";
import { GONE_STATES } from "./resolvers.js";

const gone = (state: string | null | undefined) => GONE_STATES.has(String(state ?? "").toLowerCase());
const PRIOR_STATE = "state_before_it_left";

let registered = false;

/** What `update` and `updateIf` write for these fields. */
function patchOf(fields: Record<string, unknown>): Record<string, unknown> {
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
  return patch;
}

export function registerMachinesWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("machines:machine", {
    table: "machines_machines",
    snapshotDeletion: async (orgId, id) => snapshotRowTree(await platform().tenants.getDb(orgId), "machines_machines", id, "machines_"),
    restoreDeletion: async (orgId, snapshot) => restoreRowTree(await platform().tenants.getDb(orgId), "machines_machines", snapshot, "machines_"),
    // A record that already carries the source's key is adopted by a sync, never
    // duplicated (#3836).
    findByKey: async (orgId, key, value) => findRowIdByKey(await platform().tenants.getDb(orgId), "machines_machines", key, value),
    mergeMetadata: async (orgId, id, fields) => mergeRowMetadata(await platform().tenants.getDb(orgId), "machines_machines", id, fields),
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

    /** The scan placeholder's values move into `type`, the machine's own
     *  category, before the platform removes the placeholder (#4115). */
    async adoptAxisValues(orgId, args) {
      return adoptAxisValuesIntoField(await platform().tenants.getDb(orgId), "machines_machines", args);
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      await db.updateTable("machines_machines").set(patchOf(fields) as never).where("id", "=", id).execute();
      void platform().events.emit("machines.machine.updated", { orgId, machineId: id });
    },

    version: async (orgId, id) => rowVersionOf(await platform().tenants.getDb(orgId), "machines_machines", id),

    async updateIf(orgId, id, fields, version) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const v = await updateRowAt(db, "machines_machines", id, patchOf(fields), version);
      if (v) void platform().events.emit("machines.machine.updated", { orgId, machineId: id });
      return v;
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      await db.deleteFrom("machines_machines").where("id", "=", id).execute();
      void platform().events.emit("machines.machine.deleted", { orgId, machineId: id });
    },

    /** A machine that left the collection keeps its row; its lifecycle state
     *  says how it left, beside "loaned" and "decommissioned". */
    async retire(orgId, id, how) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      // The state it left from is kept, so bringing it back puts it back as
      // it was ("in storage" comes back in storage, not "working").
      const row = await db.selectFrom("machines_machines").select("state").where("id", "=", id).executeTakeFirst();
      const prior = row?.state && !gone(row.state) ? row.state : null;
      if (prior) await mergeRowMetadata(db, "machines_machines", id, { [PRIOR_STATE]: prior });
      await db
        .updateTable("machines_machines")
        .set({ state: DISPOSITION_LABELS[how.disposition], updated_at: new Date() } as never)
        .where("id", "=", id)
        .execute();
      void platform().events.emit("machines.machine.updated", { orgId, machineId: id });
    },

    async unretire(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const row = await db.selectFrom("machines_machines").select(["state", "metadata"]).where("id", "=", id).executeTakeFirst();
      if (!row) return;
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const prior = typeof m[PRIOR_STATE] === "string" ? (m[PRIOR_STATE] as string) : null;
      if (!gone(row.state)) return;
      await db
        .updateTable("machines_machines")
        .set({ state: prior ?? "working", updated_at: new Date() } as never)
        .where("id", "=", id)
        .execute();
      await mergeRowMetadata(db, "machines_machines", id, { [PRIOR_STATE]: null });
      void platform().events.emit("machines.machine.updated", { orgId, machineId: id });
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

    // What a machine counts as it is used, so a maintenance schedule can be
    // due "every 200 print hours" (#3876). machines:record-usage writes them.
    counters: {
      defs: [
        { key: "print_hours", label: "print hours" },
        { key: "print_count", label: "prints" },
      ],
      async read(orgId, id) {
        const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
        const row = await db.selectFrom("machines_machines").select("metadata").where("id", "=", id).executeTakeFirst();
        const m = (row?.metadata ?? {}) as Record<string, unknown>;
        const num = (v: unknown): number | null => {
          const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
          return Number.isFinite(n) ? n : null;
        };
        return { print_hours: num(m.print_hours), print_count: num(m.print_count) };
      },
    },

    // Existing machines, for the import preview's name-merge.
    async listForMatch(orgId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const rows = await db.selectFrom("machines_machines").select(["id", "name", "instance"]).execute();
      // The instance (3D printers, laser cutters) is the kind a sync matches
      // on: a laser called "Mini" is not the printer called "Mini" (#6336).
      return rows.map((r) => ({ id: r.id, name: r.name, instance: r.instance }));
    },

    // Current fields of one machine — for the preview's both-sides diff, and
    // for a sync deciding what the person changed.
    async read(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const row = await db
        .selectFrom("machines_machines")
        .select(["name", "short_name", "family", "type", "manufacturer", "serial_number", "state", "image_path", "notes", "location_id", "excitement", "quantity", "instance", "metadata"])
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
        location_id: row.location_id,
        // Every field a sync writes is readable here: a sync keeps what the
        // person changed only for the fields it can see (#6336).
        excitement: row.excitement,
        quantity: row.quantity,
        instance: row.instance,
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
