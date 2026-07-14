// Spoolman integration — the "Spoolman is the tracker" half of consumption.
//
// When you run Spoolman (the filament-spool manager), it owns each spool's
// measured remaining weight. Cobblr links a part to a Spoolman spool
// (metadata.spoolman_id) and PULLS that number in on sync; the part is marked
// metadata.tracked_by = "spoolman", which makes inventory.adjust-stock skip it
// (so a print's deduction doesn't double-count what Moonraker already reported
// to Spoolman). Parts NOT linked to Spoolman stay Cobblr-tracked (the internal
// consumption ledger). Coordinate-not-control: we read/mirror over HTTP.
//
// The Spoolman connection (base_url + optional api key) reuses the platform
// device-connection store with type="spoolman" — free credential encryption,
// one connections home. digifab type-filters its own views so this never leaks
// into the farm.

import { Router } from "express";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import type { InventoryDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const spoolmanRouter = Router({ mergeParams: true });

export const SPOOLMAN_TYPE = "spoolman";
const store = () => platform().devices.connections();

interface SpoolmanSpool {
  id: number;
  archived?: boolean;
  remaining_weight?: number;
  filament?: {
    name?: string;
    vendor?: { name?: string };
    material?: string;
    weight?: number; // full filament weight (capacity), grams
    color_hex?: string;
  };
}

/** Block the cloud-metadata address; everything else (incl. LAN) is allowed —
 *  Spoolman is a self-hosted LAN service by design. */
function assertSafeUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.hostname === "169.254.169.254" || u.hostname === "metadata.google.internal") {
    throw new Error("blocked host");
  }
  return u;
}

async function fetchSpools(baseUrl: string, apiKey: string | null): Promise<SpoolmanSpool[]> {
  const base = assertSafeUrl(baseUrl);
  const url = `${base.origin}${base.pathname.replace(/\/$/, "")}/api/v1/spool`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
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
  api_key: z.string().max(500).optional(),
});
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
spoolmanRouter.delete(
  "/connections/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await store().remove(tenantContext(req).org.id, req.params.id!);
    res.status(204).end();
  }),
);

// ── sync: pull Spoolman spools → upsert parts (qty = remaining) ──
const SyncBody = z.object({ connection_id: z.string().uuid(), instance: z.string().max(120).optional() });
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
      spools = await fetchSpools(conn.base_url, apiKey);
    } catch (err) {
      await store().setProbe(ctx.org.id, conn.id, {}, (err as Error).message.slice(0, 120)).catch(() => {});
      return void res.status(502).json({ error: { code: "spoolman_unreachable", message: (err as Error).message } });
    }

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
        tracked_by: SPOOLMAN_TYPE,
      };
      if (typeof sp.filament?.weight === "number") meta.capacity = sp.filament.weight;
      if (sp.filament?.color_hex) meta.color = `#${sp.filament.color_hex.replace(/^#/, "")}`;
      if (sp.filament?.material) meta.material = sp.filament.material;

      const existing = await db
        .selectFrom("inventory_parts")
        .select(["id", "metadata"])
        .where("instance", "=", instance)
        .where(sql`metadata->>'spoolman_id'`, "=", String(sp.id))
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable("inventory_parts")
          .set({
            name,
            qty: String(remaining),
            unit: "g",
            // Overlay just the Spoolman-synced keys, DB-side — a part's metadata
            // is multi-writer, and a snapshot rewrite dropped the rest on each sync.
            metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb` as never,
            updated_at: new Date(),
          })
          .where("id", "=", existing.id)
          .execute();
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
          .execute();
        created++;
      }
    }
    await store().setProbe(ctx.org.id, conn.id, { spools: spools.length }, "ok").catch(() => {});
    res.json({ ok: true, synced: spools.length, created, updated });
  }),
);
