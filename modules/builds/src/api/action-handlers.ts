// builds action handlers. `builds.build-one` is the userInvokable + wire target
// that records building N of a build: decrement each component from inventory
// stock (via inventory:adjust-stock), log a run, and — if the build has an
// output part — increment it, unless a fabrication job defers that to its good
// verdict (`builds.credit-output`). The consume math lives in build-engine.ts (shared
// with the route). Reads inventory ONLY through the platform — no joins.

import { sql, type Kysely } from "kysely";
import { isActionRefusal, platform } from "@cobblr/platform-contract";
import type { BuildsDB } from "../db.js";
import { consumePlan, explodeLeafComponents, planBuild, planLines } from "../build-engine.js";
import { closeFilledWorkOrders, madeByWorkOrder } from "../work-orders.js";

let registered = false;

interface BuildOneArgs {
  build_id?: string;
  qty?: number;
}

export function registerBuildsActionHandlers(): void {
  registerUndos();
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("builds.build-one", async (ctx) => {
    const args = (ctx.args as BuildOneArgs | null) ?? {};
    // When fired by a wire (e.g. digifab.job.build_committed on send), the build
    // + qty ride on the event payload — same fallback as machines:record-usage.
    const ev = (ctx.event?.payload ?? {}) as { buildId?: string; qty?: number; outputOnGood?: boolean };
    // A fabrication job defers the output to its good verdict (#4050): the
    // components are used now, the parts count as made when they are judged
    // good (builds.credit-output), so a failed print never adds stock.
    const deferOutput = ev.outputOnGood === true;
    // Build id: explicit arg, else the wired event, else the entity the action
    // runs on (target='self').
    const buildId =
      args.build_id?.trim() ||
      ev.buildId?.trim() ||
      (ctx.entity?.kind === "builds:build" ? ctx.entity.id : undefined);
    if (!buildId) return { ok: false, skipped: "no build_id" };
    const qty = Math.max(1, Math.floor(Number(args.qty ?? ev.qty ?? 1)) || 1);

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const build = await db
      .selectFrom("builds_builds")
      .selectAll()
      .where("id", "=", buildId)
      .executeTakeFirst();
    if (!build) return { ok: false, skipped: "build not found" };
    if ((build.metadata as { assembly?: unknown } | null)?.assembly) return { ok: false, error: "Use this board revision’s assembly work order to record production." };

    // Stocked sub-assemblies first, the rest exploded down to leaf parts; consume both.
    const plan = await planBuild(ctx.orgId, buildId, qty);

    let consumed: Awaited<ReturnType<typeof consumePlan>>;
    try {
      consumed = await consumePlan(ctx.orgId, ctx.userId, buildId, plan);
    } catch (e) {
      if (isActionRefusal(e)) return { ok: false, error: e.message };
      throw e;
    }

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

    // Genealogy (rung 8): record input + output edges for the wire-fired run too
    // (no serial/lot — those come from the interactive build form).
    if (consumed.length > 0) {
      await db
        .insertInto("builds_run_inputs")
        .values(consumed.map((c) => ({ run_id: run.id, part_id: c.part_id, lot_code: null, quantity: String(c.quantity) })))
        .execute();
    }
    if (build.output_part_id) {
      await db
        .insertInto("builds_run_outputs")
        .values({ run_id: run.id, part_id: build.output_part_id, serial_code: null, quantity: String((Number(build.output_qty) || 1) * qty) })
        .execute();
    }

    if (build.output_part_id && !deferOutput) {
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
        })
        .catch((e) => console.error("[builds] output adjust-stock failed:", (e as Error).message));
    }

    void platform().events.emit("builds.build.completed", {
      orgId: ctx.orgId,
      buildId,
      qtyBuilt: qty,
      viaWire: ctx.event?.trigger_type === "event",
    });
    const lines = planLines(plan);
    return { ok: true, runId: run.id, buildId, qtyBuilt: qty, consumed, outputDeferred: deferOutput, ...(lines.length ? { summary: `Built ${qty} ${build.name}. ${lines.join("; ")}.` } : {}) };
  });

  // The output leg of a deferred build-one: N builds came out good, so their
  // output counts as made. Fired by the seeded digifab.job.build_output wire
  // when a plate is judged good; not user-invokable.
  platform().actions.registerHandler("builds.credit-output", async (ctx) => {
    const args = (ctx.args as BuildOneArgs | null) ?? {};
    const ev = (ctx.event?.payload ?? {}) as { buildId?: string; qty?: number; jobId?: string };
    const buildId =
      args.build_id?.trim() ||
      ev.buildId?.trim() ||
      (ctx.entity?.kind === "builds:build" ? ctx.entity.id : undefined);
    if (!buildId) return { ok: false, skipped: "no build_id" };
    const qty = Math.max(1, Math.floor(Number(args.qty ?? ev.qty ?? 1)) || 1);
    // A job's output is credited once, however often digifab asks (a retried
    // verdict, its sweep): the credit is keyed to the job, and once applied
    // (or found applied) builds says so, which is what stamps the job.
    const jobId = typeof ev.jobId === "string" && ev.jobId ? ev.jobId : undefined;
    const credited = async (made: number) => { if (jobId) await platform().events.emit("builds.output.credited", { orgId: ctx.orgId, jobId, buildId, made }); };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const build = await db.selectFrom("builds_builds").selectAll().where("id", "=", buildId).executeTakeFirst();
    if (!build) return { ok: false, skipped: "build not found" };
    if (!build.output_part_id) { await credited(0); return { ok: true, skipped: "the build has no output part" }; }

    const made = (Number(build.output_qty) || 1) * qty;
    const res = (await platform().actions.invoke("inventory:adjust-stock", {
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
      args: { partId: build.output_part_id, delta: made, reason: `build-output:${buildId}`, ...(jobId ? { once: true, sourceKind: "digifab:job-output", sourceId: jobId } : {}) },
    })) as { ok?: boolean; error?: string } | null;
    if (!res?.ok) return { ok: false, error: res?.error ?? "the output could not be added to stock" };
    await credited(made);
    return { ok: true, buildId, made };
  });

  // The quality leg (#4053): a judged print writes its good and scrap into the
  // build's quantity log, so "9 good, 1 scrap" on the plate is the same record
  // the build's yield and its work orders read. Fired by the seeded
  // digifab.job.outcome wire for every judged job; a job with no build is
  // skipped. Counts once per job: the (source_job_id, kind) index refuses a
  // second row, and ON CONFLICT turns a re-delivered verdict into a no-op.
  platform().actions.registerHandler("builds.record-yield", async (ctx) => {
    const ev = (ctx.event?.payload ?? {}) as {
      jobId?: string;
      buildId?: string | null;
      goodQty?: number;
      scrapQty?: number;
      source?: string;
    };
    const buildId = ev.buildId?.trim();
    const jobId = ev.jobId?.trim();
    if (!buildId || !jobId) return { ok: true, skipped: "not a print that makes a build" };
    const good = Math.max(0, Math.floor(Number(ev.goodQty) || 0));
    const scrap = Math.max(0, Math.floor(Number(ev.scrapQty) || 0));
    if (good === 0 && scrap === 0) return { ok: true, skipped: "nothing counted" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const build = await db.selectFrom("builds_builds").select(["id"]).where("id", "=", buildId).executeTakeFirst();
    if (!build) return { ok: false, skipped: "build not found" };

    const reason = ev.source ? `print verdict (${ev.source})` : "print verdict";
    const rows = [
      ...(good > 0 ? [{ kind: "good", quantity: String(good) }] : []),
      ...(scrap > 0 ? [{ kind: "scrap", quantity: String(scrap) }] : []),
    ].map((r) => ({ ...r, build_id: buildId, operation_id: null, source_job_id: jobId, reason, logged_by: ctx.userId ?? null }));
    const inserted = await db
      .insertInto("builds_op_qty")
      .values(rows)
      .onConflict((oc) => oc.columns(["source_job_id", "kind"]).where("source_job_id", "is not", null).doNothing())
      .returning(["kind"])
      .execute();
    // Good parts that went in may fill a work order: close each one that has
    // now been handed its full qty (work-orders.ts, oldest first).
    if (inserted.some((r) => r.kind === "good")) await closeFilledWorkOrders(db, ctx.orgId, buildId);
    // Only a row that went in speaks: a re-delivered verdict is silent.
    if (inserted.some((r) => r.kind === "scrap")) {
      await platform().events.emit("builds.operation.scrapped", {
        orgId: ctx.orgId,
        buildId,
        operationId: null,
        operationName: "print",
        quantity: scrap,
        reason,
      });
    }
    return { ok: true, buildId, good, scrap };
  });

  // A work order for a part, made for a record in another module (a sales
  // order): plan the build that produces the part. The caller names the part,
  // never a build, because which build makes what is this module's knowledge.
  // One open work order per (source, build): asking again sets its qty.
  platform().actions.registerHandler("builds.plan-for", async (ctx) => {
    const a = (ctx.args ?? {}) as { part_id?: string; qty?: number; source_kind?: string; source_id?: string; due_date?: string | null };
    const partId = String(a.part_id ?? "").trim();
    const qty = Math.floor(Number(a.qty));
    if (!partId || !(qty > 0)) return { ok: false, error: "Name the part and how many to make." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const builds = await db
      .selectFrom("builds_builds")
      .select(["id", "name", "metadata"])
      .where("output_part_id", "=", partId)
      .orderBy("updated_at", "desc")
      .execute();
    if (builds.length === 0) {
      const part = await platform().entities.lookup(ctx.orgId, "inventory:part", partId).catch(() => null);
      return { ok: false, code: "no_build", error: `Nothing is set up to make ${part?.title ?? "this part"} yet. Add a build that makes it, then make it from here.` };
    }
    const build = builds[0]!;
    if ((build.metadata as { assembly?: unknown } | null)?.assembly) return { ok: false, error: "Create this board revision through the assembly work order workflow." };
    const sourceKind = a.source_kind?.trim() || null;
    const sourceId = a.source_id?.trim() || null;
    const open = sourceKind && sourceId
      ? await db
          .selectFrom("builds_planned")
          .select(["id"])
          .where("build_id", "=", build.id)
          .where("source_kind", "=", sourceKind)
          .where("source_id", "=", sourceId)
          .where("status", "=", "planned")
          .executeTakeFirst()
      : undefined;
    let plannedId: string;
    if (open) {
      await db.updateTable("builds_planned").set({ qty: String(qty), updated_at: new Date() }).where("id", "=", open.id).execute();
      plannedId = open.id;
    } else {
      // check-then-insert: ordinary planned builds have no unique source key; board revisions refuse this path and use locked assembly request keys.
      const row = await db
        .insertInto("builds_planned")
        .values({ build_id: build.id, qty: String(qty), due_date: a.due_date ?? null, source_kind: sourceKind, source_id: sourceId })
        .returning(["id"])
        .executeTakeFirstOrThrow();
      plannedId = row.id;
      void platform().events.emit("builds.planned.created", { orgId: ctx.orgId, plannedId, buildId: build.id, sourceKind, sourceId });
    }
    // Parts already counted may cover it: a work order for 3 when 5 spare were
    // made is done the moment it exists.
    await closeFilledWorkOrders(db, ctx.orgId, build.id);
    return { ok: true, plannedId, buildId: build.id, buildName: build.name, reused: !!open };
  });

  // The work orders made for one record, with how many each has made. What a
  // sales order reads to say "3 of 5 made" beside its line.
  platform().actions.registerHandler("builds.work-orders-for", async (ctx) => {
    const a = (ctx.args ?? {}) as { source_kind?: string; source_id?: string };
    if (!a.source_kind || !a.source_id) return { ok: true, items: [] };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const mine = await db
      .selectFrom("builds_planned")
      .innerJoin("builds_builds", "builds_builds.id", "builds_planned.build_id")
      .select(["builds_planned.id as id", "builds_planned.build_id as build_id", "builds_builds.name as build_name", "builds_builds.output_part_id as output_part_id"])
      .where("builds_planned.source_kind", "=", a.source_kind)
      .where("builds_planned.source_id", "=", a.source_id)
      .where("builds_planned.status", "!=", "cancelled")
      .execute();
    const made = await madeByWorkOrder(db, [...new Set(mine.map((m) => m.build_id))]);
    return {
      ok: true,
      items: mine.map((m) => {
        const w = made.get(m.id);
        return { id: m.id, build_id: m.build_id, build_name: m.build_name, output_part_id: m.output_part_id, qty: w?.qty ?? 0, made: w?.made ?? 0, status: w?.status ?? "planned" };
      }),
    };
  });

  // The failure leg of build-one: a recorded build whose fabrication run then
  // failed / was cancelled / was scrapped. Puts every leaf component back into
  // inventory and removes the output credit, and logs a NEGATIVE run so the
  // ledger shows the reversal rather than silently editing history. Fired by the
  // seeded digifab.job.build_reversed wire; not user-invokable.
  platform().actions.registerHandler("builds.reverse-one", async (ctx) => {
    const args = (ctx.args as BuildOneArgs | null) ?? {};
    const ev = (ctx.event?.payload ?? {}) as { buildId?: string; qty?: number; outputCredited?: boolean };
    const buildId =
      args.build_id?.trim() ||
      ev.buildId?.trim() ||
      (ctx.entity?.kind === "builds:build" ? ctx.entity.id : undefined);
    if (!buildId) return { ok: false, skipped: "no build_id" };
    const qty = Math.max(1, Math.floor(Number(args.qty ?? ev.qty ?? 1)) || 1);
    // A deferred output that was never credited has nothing to take back:
    // taking it anyway would remove parts made by some other, good, job.
    const takeBackOutput = ev.outputCredited !== false;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const build = await db
      .selectFrom("builds_builds")
      .selectAll()
      .where("id", "=", buildId)
      .executeTakeFirst();
    if (!build) return { ok: false, skipped: "build not found" };

    // What the latest run took, per unit, comes back: a sub-assembly taken from
    // the shelf goes back as itself, not as the parts it would have been made of.
    // A build never run through Cobblr gives back its exploded parts, as before.
    const last = await db
      .selectFrom("builds_runs")
      .select(["qty_built", "consumed"])
      .where("build_id", "=", buildId)
      .where(sql<boolean>`qty_built::numeric > 0`)
      .orderBy("built_at", "desc")
      .executeTakeFirst();
    const lastQty = Number(last?.qty_built) || 0;
    const took = Array.isArray(last?.consumed) ? (last!.consumed as Array<{ part_id?: unknown; quantity?: unknown }>) : [];
    const comps = lastQty > 0 && took.length
      ? took.filter((c) => typeof c.part_id === "string" && Number(c.quantity) > 0).map((c) => ({ part_id: c.part_id as string, quantity: Number(c.quantity) / lastQty }))
      : await explodeLeafComponents(ctx.orgId, buildId);
    const returned: Array<{ part_id: string; quantity: number }> = [];
    for (const c of comps) {
      const inc = c.quantity * qty;
      if (inc <= 0) continue;
      await platform()
        .actions.invoke("inventory:adjust-stock", {
          orgId: ctx.orgId,
          userId: ctx.userId,
          entity: { kind: "inventory:part", id: c.part_id },
          event: {
            name: "builds.build.reversed",
            payload: {},
            actor: { user_id: ctx.userId, display_name: null, auth_method: "session" },
            timestamp: ctx.event?.timestamp ?? new Date().toISOString(),
            trigger_type: "event",
          },
          args: { partId: c.part_id, delta: inc, reason: `build-reversed:${buildId}` },
        })
        .catch((e) => console.error("[builds] reverse adjust-stock failed:", (e as Error).message));
      returned.push({ part_id: c.part_id, quantity: inc });
    }

    const run = await db
      .insertInto("builds_runs")
      .values({
        build_id: buildId,
        qty_built: String(-qty),
        consumed: sql`${JSON.stringify(returned.map((r) => ({ ...r, quantity: -r.quantity })))}::jsonb` as never,
        built_by: ctx.userId,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    if (build.output_part_id && takeBackOutput) {
      const unmade = (Number(build.output_qty) || 1) * qty;
      await platform()
        .actions.invoke("inventory:adjust-stock", {
          orgId: ctx.orgId,
          userId: ctx.userId,
          entity: { kind: "inventory:part", id: build.output_part_id },
          event: {
            name: "builds.build.reversed",
            payload: {},
            actor: { user_id: ctx.userId, display_name: null, auth_method: "session" },
            timestamp: ctx.event?.timestamp ?? new Date().toISOString(),
            trigger_type: "event",
          },
          args: { partId: build.output_part_id, delta: -unmade, reason: `build-output-reversed:${buildId}` },
        })
        .catch((e) => console.error("[builds] output reverse adjust-stock failed:", (e as Error).message));
    }

    void platform().events.emit("builds.build.reversed", {
      orgId: ctx.orgId,
      buildId,
      qtyReversed: qty,
      viaWire: ctx.event?.trigger_type === "event",
    });
    return { ok: true, runId: run.id, buildId, qtyReversed: qty, returned };
  });
}

// A build is reversed, a reversal is built again: each is the other's inverse
// on the same build and quantity, and each is a run of its own in the history.
function registerUndos(): void {
  const on = (ctx: { entity?: { kind: string; id: string } }, buildId: string) =>
    ctx.entity?.kind === "builds:build" ? { entity_kind: "builds:build", entity_id: ctx.entity.id } : { entity_kind: "builds:build", entity_id: buildId };
  platform().actions.registerUndo("builds.build-one", (result, ctx) => {
    const r = result as { ok?: unknown; buildId?: unknown; qtyBuilt?: unknown } | null;
    if (r?.ok !== true || typeof r.buildId !== "string" || typeof r.qtyBuilt !== "number") return null;
    return { action_id: "builds:reverse-one", args: { build_id: r.buildId, qty: r.qtyBuilt }, ...on(ctx, r.buildId) };
  });
  platform().actions.registerUndo("builds.reverse-one", (result, ctx) => {
    const r = result as { ok?: unknown; buildId?: unknown; qtyReversed?: unknown } | null;
    if (r?.ok !== true || typeof r.buildId !== "string" || typeof r.qtyReversed !== "number") return null;
    return { action_id: "builds:build-one", args: { build_id: r.buildId, qty: r.qtyReversed }, ...on(ctx, r.buildId) };
  });
}
