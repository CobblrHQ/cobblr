// Super-admin CRUD for the global vendor scan-URL resolver list. Built-in
// resolvers (Polar) ship in code and are read-only unless an operator row with
// the same id overrides them; operators add new vendors as data rows. Mounted at
// /super-admin/scan-url-resolvers (platform-admin gated by the parent router).
// Every write refreshes the in-memory manifest list the generic resolver consults.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { BUILTIN_SCAN_URL_RESOLVERS } from "../platform/scan-url-resolvers/builtins.js";
import { refreshScanUrlManifests } from "../platform/scan-url-resolvers/register.js";
import { ScanUrlResolverManifest } from "../platform/scan-url-resolvers/types.js";

export const scanResolversRouter = Router();

async function operatorRows() {
  return meta
    .selectFrom("scan_url_resolvers")
    .select(["resolver_id", "label", "enabled", "position", "manifest"])
    .orderBy("position")
    .execute();
}

// GET / — built-ins (minus any overridden) + operator rows.
scanResolversRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await operatorRows();
    const overridden = new Set(rows.map((r) => r.resolver_id));
    const builtins = BUILTIN_SCAN_URL_RESOLVERS.filter((m) => !overridden.has(m.id)).map((m) => ({
      resolver_id: m.id,
      label: m.label,
      enabled: m.enabled,
      position: -1,
      manifest: m,
      builtin: true,
    }));
    const operator = rows.map((r) => ({ ...r, builtin: false }));
    res.json({ items: [...builtins, ...operator] });
  } catch (err) {
    next(err);
  }
});

// POST / — add a vendor (or override a built-in by reusing its id). Upsert.
scanResolversRouter.post("/", async (req, res, next) => {
  try {
    const parsed = ScanUrlResolverManifest.safeParse(req.body?.manifest);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_manifest", message: parsed.error.message } });
      return;
    }
    const m = parsed.data;
    await meta
      .insertInto("scan_url_resolvers")
      .values({
        resolver_id: m.id,
        label: m.label,
        enabled: m.enabled,
        position: typeof req.body?.position === "number" ? req.body.position : 0,
        manifest: JSON.stringify(m),
      })
      .onConflict((oc) =>
        oc.column("resolver_id").doUpdateSet({
          label: m.label,
          enabled: m.enabled,
          manifest: JSON.stringify(m),
          updated_at: sql`now()`,
        }),
      )
      .execute();
    await refreshScanUrlManifests();
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id — toggle/edit. If the id is a built-in with no row yet, seed an
// override row from the built-in so a built-in can be disabled/edited too.
scanResolversRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        label: z.string().min(1).max(120).optional(),
        position: z.number().int().optional(),
        manifest: ScanUrlResolverManifest.optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "invalid_body", message: body.error.message } });
      return;
    }
    const id = req.params.id;
    const existing = await meta
      .selectFrom("scan_url_resolvers")
      .select(["resolver_id", "manifest"])
      .where("resolver_id", "=", id)
      .executeTakeFirst();
    if (!existing) {
      const builtin = BUILTIN_SCAN_URL_RESOLVERS.find((m) => m.id === id);
      if (!builtin) {
        res.status(404).json({ error: { code: "not_found", message: "resolver not found" } });
        return;
      }
      const manifest = { ...builtin, ...(body.data.manifest ?? {}), enabled: body.data.enabled ?? builtin.enabled };
      await meta
        .insertInto("scan_url_resolvers")
        .values({
          resolver_id: id,
          label: body.data.label ?? builtin.label,
          enabled: manifest.enabled,
          position: body.data.position ?? 0,
          manifest: JSON.stringify(manifest),
        })
        .execute();
    } else {
      const patch: Record<string, unknown> = { updated_at: sql`now()` };
      if (body.data.enabled !== undefined) patch.enabled = body.data.enabled;
      if (body.data.label !== undefined) patch.label = body.data.label;
      if (body.data.position !== undefined) patch.position = body.data.position;
      if (body.data.manifest) patch.manifest = JSON.stringify(body.data.manifest);
      await meta.updateTable("scan_url_resolvers").set(patch).where("resolver_id", "=", id).execute();
    }
    await refreshScanUrlManifests();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — remove an operator row (restores the built-in if it was an override).
scanResolversRouter.delete("/:id", async (req, res, next) => {
  try {
    await meta.deleteFrom("scan_url_resolvers").where("resolver_id", "=", req.params.id).execute();
    await refreshScanUrlManifests();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /test — resolve a sample URL through the live resolver chain.
scanResolversRouter.post("/test", async (req, res, next) => {
  try {
    const body = z.object({ url: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "invalid_body", message: body.error.message } });
      return;
    }
    const resolution = await platform()
      .scan.resolveUrl(body.data.url.trim(), { force: true })
      .catch(() => null);
    res.json({ matched: !!resolution, resolution });
  } catch (err) {
    next(err);
  }
});
