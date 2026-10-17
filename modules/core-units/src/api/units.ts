// /units — the workspace's unit vocabulary + display preference.
//
//   GET  /units            → { builtins, custom, display_mode }
//   POST /units            → add a custom unit (owner/admin)
//   DELETE /units/:code    → remove a custom unit (owner/admin)
//   GET  /units/settings   → { display_mode }
//   PUT  /units/settings   → set display_mode (owner/admin)
//
// The client fetches this once and formats quantities itself
// (formatQuantity in units-catalog.ts is mirrored into platform-web).

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { tenantDb, type CoreUnitsDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { BUILTIN_UNITS } from "../units-catalog.js";

export const unitsRouter = Router({ mergeParams: true });

/** Exported so the core-units:add-unit handler validates a unit the SAME way
 *  this route does — the shadowing rule and the code format must not mean one
 *  thing when a person adds a unit and another when the assistant does. */
export const CustomUnit = z.object({
  code: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "code must be lowercase letters, digits, hyphens"),
  symbol: z.string().min(1).max(16),
  name: z.string().min(1).max(40),
  plural: z.string().min(1).max(40).optional(),
  category: z
    .enum(["count", "mass", "length", "area", "volume", "time", "electrical", "digital"])
    .optional(),
});

async function readDisplayMode(req: Parameters<typeof tenantDb>[0]): Promise<string> {
  const db = tenantDb(req);
  const row = await db
    .selectFrom("core_units_settings")
    .select("display_mode")
    .where("id", "=", 1)
    .executeTakeFirst();
  return row?.display_mode ?? "symbol";
}

unitsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const [custom, display_mode] = await Promise.all([
      db
        .selectFrom("core_units_custom")
        .select(["code", "symbol", "name", "plural", "category"])
        .orderBy("category")
        .orderBy("name")
        .execute(),
      readDisplayMode(req),
    ]);
    res.json({ builtins: BUILTIN_UNITS, custom, display_mode });
  }),
);

// AI-ACTION: core-units:add-unit
unitsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-units:add-unit"))) return;
    const parsed = CustomUnit.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    // A workspace custom unit must not shadow a built-in code.
    if (BUILTIN_UNITS.some((u) => u.code === parsed.data.code)) {
      res.status(409).json({
        error: { code: "builtin_exists", message: `"${parsed.data.code}" is a built-in unit` },
      });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_units_custom")
      .values({
        code: parsed.data.code,
        symbol: parsed.data.symbol,
        name: parsed.data.name,
        plural: parsed.data.plural ?? parsed.data.name,
        category: parsed.data.category ?? "count",
      })
      .onConflict((oc) =>
        oc.column("code").doUpdateSet({
          symbol: parsed.data.symbol,
          name: parsed.data.name,
          plural: parsed.data.plural ?? parsed.data.name,
          category: parsed.data.category ?? "count",
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// AI-ACTION: core-units:remove-unit
unitsRouter.delete(
  "/:code",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-units:remove-unit"))) return;
    const code = req.params.code;
    if (!code) {
      res.status(400).json({ error: { code: "missing_code", message: "code required" } });
      return;
    }
    const db = tenantDb(req);
    await db.deleteFrom("core_units_custom").where("code", "=", code).execute();
    res.status(204).end();
  }),
);

unitsRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json({ display_mode: await readDisplayMode(req) });
  }),
);

export const DISPLAY_MODES = ["symbol", "name", "both"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** The one write of the workspace's unit display, for the route and core-units:set-display-mode. */
export async function writeDisplayMode(db: Kysely<CoreUnitsDB>, mode: DisplayMode): Promise<void> {
  await db
    .insertInto("core_units_settings")
    .values({ id: 1, display_mode: mode })
    .onConflict((oc) => oc.column("id").doUpdateSet({ display_mode: mode, updated_at: new Date() }))
    .execute();
}

// AI-ACTION: core-units:set-display-mode
unitsRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-units:set-display-mode"))) return;
    const parsed = z
      .object({ display_mode: z.enum(DISPLAY_MODES) })
      .safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    await writeDisplayMode(tenantDb(req), parsed.data.display_mode);
    res.json({ display_mode: parsed.data.display_mode });
  }),
);
