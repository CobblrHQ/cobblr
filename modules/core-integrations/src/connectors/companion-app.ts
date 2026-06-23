// companion app sync connector — the FIRST SyncConnector definition.
//
// Mirrors companion app locations (rooms / racks / bins) into core-locations:location.
// companion app is a registered definition exactly like Slack/Discord — nothing
// companion app-specific lives in the kernel or the engine. Adding the next connector
// (Notion, a sheet, …) is "register another", never a rewrite.

import {
  platform,
  type SyncFetchContext,
  type SyncRecord,
  type SyncWebhookHit,
} from "@cobblr/platform-contract";

interface WosLocation {
  id: number;
  name: string;
  short_name?: string | null;
  parent_id?: number | null;
  room_id?: number | null;
  kind?: string; // "room" | "area" | "bin"
  bin_number?: number | null;
}

/** companion app room = a place (core "area"); racks/shelves/bins hold things
 *  (core "container"). */
function mapKind(k: unknown): "area" | "container" {
  return k === "room" ? "area" : "container";
}

function mapLocation(l: WosLocation): SyncRecord {
  return {
    externalId: String(l.id),
    parentExternalId: l.parent_id != null ? String(l.parent_id) : null,
    fields: {
      name: l.name,
      short_name: l.short_name ?? null,
      kind: mapKind(l.kind),
      metadata: {
        source: "companion app",
        wos_kind: l.kind ?? null,
        wos_id: l.id,
        bin_number: l.bin_number ?? null,
        room_id: l.room_id ?? null,
      },
    },
  };
}

async function wosGet(ctx: SyncFetchContext, path: string): Promise<unknown> {
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const token = String(ctx.credentials.token ?? "");
  const res = await ctx.fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`companion app ${path} → ${res.status}`);
  return res.json();
}

let registered = false;

export function registercompanion appConnector(): void {
  if (registered) return;
  registered = true;

  platform().integrations.registerSyncConnector({
    id: "companion app",
    label: "companion app",
    describeCredentials: () => ({ token: { label: "API token", secret: true } }),
    describeConfig: () => ({
      base_url: { label: "companion app URL", placeholder: "http://workshop.local:4000" },
    }),
    entityTypes: [
      {
        key: "locations",
        label: "Locations (rooms, racks, bins)",
        targetKind: "core-locations:location",
        async fetchAll(ctx) {
          const body = (await wosGet(ctx, "/api/v1/locations")) as { items?: WosLocation[] };
          const items = Array.isArray(body.items) ? body.items : [];
          return items.map(mapLocation);
        },
        async fetchOne(ctx, externalId) {
          try {
            const body = (await wosGet(
              ctx,
              `/api/v1/locations/${encodeURIComponent(externalId)}`,
            )) as WosLocation | { item?: WosLocation };
            const loc = (body as { item?: WosLocation }).item ?? (body as WosLocation);
            return loc && loc.id != null ? mapLocation(loc) : null;
          } catch {
            return null;
          }
        },
      },
    ],
    async testConnection(ctx) {
      try {
        await wosGet(ctx, "/api/v1/locations");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    // Webhook body shape (emitted by the companion app side):
    //   { entity: "location", action: "created"|"updated"|"deleted",
    //     id: <number>, record?: <serialized companion app location> }
    parseWebhook(body) {
      const b = body as
        | { entity?: string; action?: string; id?: number | string; record?: WosLocation }
        | null;
      if (!b || b.entity !== "location" || b.id == null) return null;
      const hit: SyncWebhookHit = {
        entityType: "locations",
        externalId: String(b.id),
        deleted: b.action === "deleted",
      };
      if (b.record && b.action !== "deleted") hit.record = mapLocation(b.record);
      return hit;
    },
  });
}
