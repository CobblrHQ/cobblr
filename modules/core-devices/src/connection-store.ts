// The device CONNECTION store — core-devices owns core_devices_connections and
// implements the platform().devices.connections() seam. Connection-managing
// consumers (digifab's CRUD routes) call this instead of touching a table they
// no longer own; the driver provider calls getInternal() to build a driver. All
// credential encryption lives here. See docs/architecture/core-devices-extraction.md §6.

import { sql, type Kysely } from "kysely";
import {
  platform,
  type DeviceConnectionStore,
  type DeviceConnectionPublic,
  type DeviceConnectionInternal,
  type DeviceConnectionCreate,
  type DeviceConnectionPatch,
} from "@cobblr/platform-contract";
import type { CoreDevicesDB } from "./db.js";

const PUBLIC_COLS = [
  // Selected so `has_credentials` can be computed, and STRIPPED again by
  // toPublic() before the row leaves. It is never part of the public shape.
  "credentials_enc",
  "id",
  "type",
  "label",
  "base_url",
  "config",
  "enabled",
  "capabilities",
  "last_sync_at",
  "last_sync_status",
  "created_at",
  "updated_at",
] as const;

/** The one way a row becomes a public connection.
 *
 *  `has_credentials` cannot be read off `config`: credentials live encrypted in
 *  their own column, so `config` is empty on a connection that authenticates
 *  perfectly well. Code that checks `config.api_key` therefore reports "no
 *  token" for every connection that has one — which is exactly the bug this
 *  exists to make unrepeatable. Every projection goes through here, so the flag
 *  cannot be present on three paths and missing on the fourth, and the
 *  ciphertext cannot ride along into a response.
 */
function toPublic(row: Record<string, unknown>): DeviceConnectionPublic {
  const { credentials_enc, ...rest } = row;
  return {
    ...rest,
    has_credentials: typeof credentials_enc === "string" && credentials_enc.length > 0,
  } as unknown as DeviceConnectionPublic;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function db(orgId: string): Promise<Kysely<CoreDevicesDB>> {
  return (await platform().tenants.getDb(orgId)) as Kysely<CoreDevicesDB>;
}

export const connectionStore: DeviceConnectionStore = {
  async list(orgId) {
    const rows = await (await db(orgId))
      .selectFrom("core_devices_connections")
      .select(PUBLIC_COLS)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((r) => toPublic(r as unknown as Record<string, unknown>));
  },

  async get(orgId, id) {
    const row = await (await db(orgId))
      .selectFrom("core_devices_connections")
      .select(PUBLIC_COLS)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toPublic(row as unknown as Record<string, unknown>) : null;
  },

  async getInternal(orgId, ref) {
    const d = await db(orgId);
    // Exact id first (only probe the uuid column for uuid-shaped refs, else a
    // label like "Irrigation" throws 22P02), then case-insensitive label.
    if (UUID_RE.test(ref)) {
      const byId = await d
        .selectFrom("core_devices_connections")
        .select(["id", "type", "base_url", "credentials_enc"])
        .where("id", "=", ref)
        .executeTakeFirst();
      if (byId) return byId as DeviceConnectionInternal;
    }
    const byLabel = await d
      .selectFrom("core_devices_connections")
      .select(["id", "type", "base_url", "credentials_enc"])
      .where(sql<boolean>`lower(label) = lower(${ref})`)
      .executeTakeFirst();
    return (byLabel as DeviceConnectionInternal) ?? null;
  },

  async create(orgId, input: DeviceConnectionCreate) {
    const creds = input.creds ?? {};
    const enc = Object.keys(creds).length
      ? await platform().integrations.encryptCredentials(orgId, creds)
      : "";
    const row = await (await db(orgId))
      .insertInto("core_devices_connections")
      .values({
        type: input.type,
        label: input.label,
        base_url: input.base_url,
        credentials_enc: enc,
        config: sql`${JSON.stringify(input.config ?? {})}::jsonb` as never,
      })
      .returning(PUBLIC_COLS)
      .executeTakeFirstOrThrow();
    return toPublic(row as unknown as Record<string, unknown>);
  },

  async update(orgId, id, patch: DeviceConnectionPatch) {
    const d = await db(orgId);
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.base_url !== undefined) set.base_url = patch.base_url;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.config !== undefined) set.config = sql`${JSON.stringify(patch.config)}::jsonb`;
    if (patch.creds) {
      // Merge with existing so updating one field doesn't wipe the others; a
      // null value clears that field.
      const existing = await d
        .selectFrom("core_devices_connections")
        .select(["credentials_enc"])
        .where("id", "=", id)
        .executeTakeFirst();
      const merged: Record<string, unknown> = existing?.credentials_enc
        ? await platform().integrations.decryptCredentials(orgId, existing.credentials_enc)
        : {};
      for (const [k, v] of Object.entries(patch.creds)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      set.credentials_enc = Object.keys(merged).length
        ? await platform().integrations.encryptCredentials(orgId, merged)
        : "";
    }
    const row = await d
      .updateTable("core_devices_connections")
      .set(set as never)
      .where("id", "=", id)
      .returning(PUBLIC_COLS)
      .executeTakeFirst();
    return row ? toPublic(row as unknown as Record<string, unknown>) : null;
  },

  async remove(orgId, id) {
    const r = await (await db(orgId))
      .deleteFrom("core_devices_connections")
      .where("id", "=", id)
      .returning(["id"])
      .executeTakeFirst();
    return !!r;
  },

  async setProbe(orgId, id, capabilities, status) {
    await (await db(orgId))
      .updateTable("core_devices_connections")
      .set({
        capabilities: sql`${JSON.stringify(capabilities)}::jsonb` as never,
        last_sync_at: new Date(),
        last_sync_status: status.slice(0, 300),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
  },
};
