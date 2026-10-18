import { serializeSpoolWrite } from "../spoolman-write-queue.js";
import { sameSpoolLink } from "../spoolman-link.js";
import { Router } from "express";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import type { InventoryDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { optionalText } from "@cobblr/platform-contract/optional-fields";

export const spoolmanRouter = Router({ mergeParams: true });

export const SPOOLMAN_TYPE = "spoolman";
const store = () => platform().devices.connections();

interface SpoolmanSpool {
  id: number;
  archived?: boolean;
  remaining_weight?: number;
  location?: string;
  filament?: {
    name?: string;
    vendor?: { name?: string };
    material?: string;
    density?: number;
    diameter?: number;
    spool_weight?: number;
    weight?: number; // full filament weight (capacity), grams
    color_hex?: string;
  };
}

/** The address as a URL, or a plain refusal. Where it may point is the
 *  workspace's egress policy (platform().egress.guardedFetch): Spoolman is a
 *  self-hosted LAN service by design, so a self-hosted instance reaches its own
 *  LAN and the hosted one does not. */
export function assertSafeUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error("not a web address");
  }
}

export async function fetchSpools(orgId: string, baseUrl: string, apiKey: string | null): Promise<SpoolmanSpool[]> {
  const base = assertSafeUrl(baseUrl);
  const url = `${base.origin}${base.pathname.replace(/\/$/, "")}/api/v1/spool`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await platform().egress.guardedFetch(orgId, url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Spoolman responded ${res.status}`);
  const body = (await res.json()) as SpoolmanSpool[];
  return Array.isArray(body) ? body : [];
}

// ── connection CRUD (type-scoped to spoolman) ──
spoolmanRouter.get(
  "/connections",
  asyncHandler(async (req, res) => {
    const all = await store().list(tenantContext(req).org.id);
    res.json({ items: all.filter((c) => c.type === SPOOLMAN_TYPE) });
  }),
);

const ConnCreate = z.object({
  label: z.string().min(1).max(120),
  base_url: z.string().url().max(500),
  api_key: optionalText(500),
});
// AI-REACH: holds or mints credentials; the assistant must never handle these
spoolmanRouter.post(
  "/connections",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = ConnCreate.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const row = await store().create(tenantContext(req).org.id, {
      type: SPOOLMAN_TYPE,
      label: p.data.label,
      base_url: p.data.base_url,
      creds: p.data.api_key ? { apiKey: p.data.api_key } : {},
    });
    res.status(201).json(row);
  }),
);
// AI-REACH: holds or mints credentials; the assistant must never handle these
spoolmanRouter.delete(
  "/connections/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await store().remove(tenantContext(req).org.id, req.params.id!);
    res.status(204).end();
  }),
);

// ── sync: pull Spoolman spools → upsert parts (qty = remaining) ──
const SyncBody = z.object({ connection_id: z.string().uuid(), instance: z.string().max(120).optional(), authority: z.enum(["spoolman", "cobblr"]).optional() });
// AI-REACH: drives an external connector with its own credentials and rate limits; a person owns that
spoolmanRouter.post(
  "/sync",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const parsed = SyncBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);

    const conn = await store().getInternal(ctx.org.id, parsed.data.connection_id);
    if (!conn || conn.type !== SPOOLMAN_TYPE) {
      return void res.status(404).json({ error: { code: "not_found", message: "no such Spoolman connection" } });
    }
    let apiKey: string | null = null;
    if (conn.credentials_enc) {
      const creds = await platform().integrations.decryptCredentials(ctx.org.id, conn.credentials_enc);
      apiKey = (creds.apiKey as string | undefined) ?? null;
    }

    let spools: SpoolmanSpool[];
    try {
      spools = await fetchSpools(ctx.org.id, conn.base_url, apiKey);
    } catch (err) {
      await store().setProbe(ctx.org.id, conn.id, {}, (err as Error).message.slice(0, 120)).catch(() => {});
      return void res.status(502).json({ error: { code: "spoolman_unreachable", message: (err as Error).message } });
    }

    const saved = await store().get(ctx.org.id, conn.id);
    const authority = parsed.data.authority ?? (saved?.config.authority === "cobblr" ? "cobblr" : "spoolman");
    const onlyConnection = (await store().list(ctx.org.id)).filter((c) => c.type === SPOOLMAN_TYPE).length === 1;
    const db = tenantDb(req) as Kysely<InventoryDB>;
    const instance = parsed.data.instance || "inventory";
    let created = 0;
    let updated = 0;
    for (const sp of spools) {
      if (sp.archived) continue;
      const name =
        [sp.filament?.vendor?.name, sp.filament?.name].filter(Boolean).join(" ").trim() || `Spool ${sp.id}`;
      const remaining = typeof sp.remaining_weight === "number" ? sp.remaining_weight : 0;
      const meta: Record<string, unknown> = {
        spoolman_id: String(sp.id),
        spoolman_connection_id: conn.id,
        spoolman_mode: authority,
        tracked_by: authority === "spoolman" ? SPOOLMAN_TYPE : null,
        spoolman_location: sp.location ?? null,
      };
      if (typeof sp.filament?.weight === "number") { meta.capacity = sp.filament.weight; meta.initial_g = sp.filament.weight; }
      if (typeof sp.filament?.density === "number") meta.density = sp.filament.density;
      if (typeof sp.filament?.diameter === "number") meta.diameter = `${sp.filament.diameter} mm`;
      if (typeof sp.filament?.spool_weight === "number") meta.empty_spool_g = sp.filament.spool_weight;
      if (sp.filament?.color_hex) meta.color = `#${sp.filament.color_hex.replace(/^#/, "")}`;
      if (sp.filament?.material) meta.material = sp.filament.material;

      const candidates = await db
        .selectFrom("inventory_parts")
        .select(["id", "metadata", "qty", "unit"])
        .where(sql`metadata->>'spoolman_id'`, "=", String(sp.id))
        .execute();
      const legacy = candidates.filter((r) => !r.metadata.spoolman_connection_id);
      const existing = candidates.find((r) => sameSpoolLink(r.metadata, conn.id, sp.id))
        ?? (onlyConnection && legacy.length === 1 ? legacy[0] : undefined);

      if (existing) {
        if (authority === "cobblr" && existing.metadata.tracked_by === "firmware") meta.tracked_by = "firmware";
        const pulling = authority === "spoolman" || (existing.metadata.spoolman_mode !== "cobblr" && existing.metadata.tracked_by === "spoolman");
        await db
          .updateTable("inventory_parts")
          .set({
            name,
            ...(pulling ? { qty: String(remaining), unit: "g" } : {}),
            // Overlay just the Spoolman-synced keys, DB-side — a part's metadata
            // is multi-writer, and a snapshot rewrite dropped the rest on each sync.
            metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb` as never,
            updated_at: new Date(),
          })
          .where("id", "=", existing.id)
          .execute();
        if (authority === "cobblr") await publishSpool(ctx.org.id, db, existing.id);
        updated++;
      } else {
        await db
          .insertInto("inventory_parts")
          .values({
            instance,
            name,
            qty: String(remaining),
            unit: "g",
            metadata: sql`${JSON.stringify(meta)}::jsonb` as never,
          })
          // Two syncs at once both found no part for this spool: it is made once
          // (the spoolman link is unique), and the second skips it.
          .onConflict((oc) => oc.doNothing())
          .execute();
        created++;
      }
    }
    await store().update(ctx.org.id, conn.id, { config: { authority } });
    await store().setProbe(ctx.org.id, conn.id, { spools: spools.length }, "ok").catch(() => {});
    res.json({ ok: true, synced: spools.length, created, updated });
  }),
);


export async function publishSpool(orgId: string, db: Kysely<InventoryDB>, id: string): Promise<void> {
  return serializeSpoolWrite(`${orgId}:${id}`, () => publishLatestSpool(orgId, db, id));
}

async function publishLatestSpool(orgId: string, db: Kysely<InventoryDB>, id: string): Promise<void> {
  const row = await db.selectFrom("inventory_parts").select(["id", "qty", "unit", "metadata"]).where("id", "=", id).executeTakeFirst();
  const md = row?.metadata;
  if (!row || md?.spoolman_mode !== "cobblr" || typeof md.spoolman_connection_id !== "string") return;
  const publicConnection = await store().get(orgId, md.spoolman_connection_id);
  if (!publicConnection?.enabled || publicConnection.type !== SPOOLMAN_TYPE) return;
  const conn = await store().getInternal(orgId, md.spoolman_connection_id);
  if (!conn || conn.type !== SPOOLMAN_TYPE) return;
  const creds = conn.credentials_enc ? await platform().integrations.decryptCredentials(orgId, conn.credentials_enc) : {};
  const remaining = await platform().units.convert(orgId, Number(row.qty), row.unit, "g");
  if (remaining == null) throw new Error("The linked spool must be kept in a weight unit.");
  if (!/^\d+$/.test(String(md.spoolman_id))) throw new Error("The linked spool has no valid Spoolman id.");
  const paths = await platform().placement.pathsOf({ orgId, containees: [{ kind: "inventory:part", id }] });
  const location = (paths.get(`inventory:part:${id}`) ?? []).map((p) => p.name).join(" / ") || String(md.spoolman_location ?? "");
  const base = assertSafeUrl(conn.base_url);
  const url = `${base.origin}${base.pathname.replace(/\/$/, "")}/api/v1/spool/${md.spoolman_id}`;
  const reply = await platform().egress.guardedFetch(orgId, url, {
    method: "PATCH", headers: { "content-type": "application/json", ...(creds.apiKey ? { authorization: `Bearer ${creds.apiKey}` } : {}) },
    body: JSON.stringify({ remaining_weight: remaining, location }), signal: AbortSignal.timeout(15000),
  });
  if (!reply.ok) throw new Error(`Spoolman write-back responded ${reply.status}`);
}

export function registerSpoolmanWriteBack() {
  platform().events.on("inventory.stock.changed", "inventory", async (raw) => {
    const event = raw as { orgId?: string; partId?: string };
    if (!event.orgId || !event.partId) return;
    const db = await platform().tenants.getDb(event.orgId) as Kysely<InventoryDB>;
    void publishSpool(event.orgId, db, event.partId).catch((err) => console.error("[inventory] Spoolman write-back deferred until sync:", (err as Error).message));
  });
  platform().sweeps.register({
    name: "inventory.spoolman-write-back", module: "inventory", everyMs: 5 * 60 * 1000,
    visit: async ({ orgId, db: raw }) => {
      const db = raw as Kysely<InventoryDB>;
      const rows = await db.selectFrom("inventory_parts").select("id").where(sql`metadata->>'spoolman_mode'`, "=", "cobblr").execute();
      let published = 0;
      for (const row of rows) {
        try { await publishSpool(orgId, db, row.id); published++; } catch (err) {
          platform().health.notePassFailure("inventory.spoolman-write-back", orgId, err);
          console.error("[inventory] Spoolman write-back deferred:", (err as Error).message);
        }
      }
      return { published };
    },
  });
}
