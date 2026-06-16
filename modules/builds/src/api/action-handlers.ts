// builds action handlers. `builds.build-one` is the userInvokable + wire target
// that records building N of a build: decrement each component from inventory
// stock (via inventory:adjust-stock), log a run, and — if the build has an
// output part — increment it. The consume math lives in build-engine.ts (shared
// with the route). Reads inventory ONLY through the platform — no joins.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { BuildsDB } from "../db.js";
import { consumeComponents, type ComponentInput } from "../build-engine.js";

let registered = false;

interface BuildOneArgs {
  build_id?: string;
  qty?: number;
}

export function registerBuildsActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("builds.build-one", async (ctx) => {
    const args = (ctx.args as BuildOneArgs | null) ?? {};
    // Build id: explicit arg, else the entity the action runs on (target='self').
    const buildId =
      args.build_id?.trim() || (ctx.entity?.kind === "builds:build" ? ctx.entity.id : undefined);
    if (!buildId) return { ok: false, skipped: "no build_id" };
    const qty = Math.max(1, Math.floor(Number(args.qty ?? 1)) || 1);

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const build = await db
      .selectFrom("builds_builds")
      .selectAll()
      .where("id", "=", buildId)
      .executeTakeFirst();
    if (!build) return { ok: false, skipped: "build not found" };

    const compRows = await db
      .selectFrom("builds_components")
      .selectAll()
      .where("build_id", "=", buildId)
      .orderBy("created_at", "asc")
      .execute();
    const comps: ComponentInput[] = compRows.map((r) => ({
      part_id: r.part_id,
      quantity: Number(r.quantity) || 0,
      optional: r.optional,
    }));

    const consumed = await consumeComponents(ctx.orgId, ctx.userId, buildId, comps, qty);

    const run = await db
      .insertInto("builds_runs")
      .values({
        build_id: buildId,
        qty_built: String(qty),
        consumed: sql`${JSON.stringify(consumed)}::jsonb` as never,
        built_by: ctx.userId,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    if (build.output_part_id) {
      const made = (Number(build.output_qty) || 1) * qty;
      await platform()
        .actions.invoke("inventory:adjust-stock", {
          orgId: ctx.orgId,
          userId: ctx.userId,
          entity: { kind: "inventory:part", id: build.output_part_id },
          event: {
            name: "builds.build.completed",
            payload: {},
            actor: { user_id: ctx.userId, display_name: null, auth_method: "session" },
            timestamp: ctx.event?.timestamp ?? new Date().toISOString(),
            trigger_type: "event",
          },
          args: { partId: build.output_part_id, delta: made, reason: `build-output:${buildId}` },
          entityKind: "inventory:part",
          entityId: build.output_part_id,
        })
        .catch((e) => console.error("[builds] output adjust-stock failed:", (e as Error).message));
    }

    void platform().events.emit("builds.build.completed", {
      orgId: ctx.orgId,
      buildId,
      qtyBuilt: qty,
      viaWire: ctx.event?.trigger_type === "event",
    });
    return { ok: true, runId: run.id, qtyBuilt: qty, consumed };
  });
}
