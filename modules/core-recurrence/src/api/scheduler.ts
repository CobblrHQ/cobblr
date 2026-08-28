// core-recurrence scheduler — the in-process timer loop that fires
// schedule-triggered wires.
//
// Q4 from docs/architecture/wires-and-bundles.md. Wires with
// `trigger_type: 'schedule'` carry an iCal RRULE in trigger_schedule;
// every minute we query for due wires across all tenants, evaluate
// the RRULE against (last_fired_at .. now], fire one occurrence per
// match, and update last_fired_at.
//
// Idempotency: state in wire_schedule_state.last_fired_at survives
// process restarts. The check is "rrule.between(last_fired_at, now)
// returns at least one occurrence" — restart-safe.

// rrule is published as CJS; named-export via default-package import.
// sweep-pools: deferred-release ok — the background tick enumerates only
// ACTIVE orgs (created <5min ago or carrying recurrence state), a small
// bounded set; the 15s deferred pool close in tenant.ts covers it.
import rrulePkg from "rrule";
import { platform } from "@cobblr/platform-contract";
const { rrulestr } = rrulePkg;

// The platform's meta-DB accessor — we need cross-tenant reads of
// entity_action_bindings + wire_schedule_state. Use the platform's
// internal `meta` accessor via a typed eval-time import to keep this
// module from depending on api/ source paths.
//
// The schedule tick reads from cobblr_meta, not a tenant DB, so we
// can't go through platform.tenants.getDb(). The platform exposes
// the meta accessor via platform().db.meta for exactly this case.

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60_000; // 1 minute

export function startRecurrenceScheduler(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  // Wrap each fire so a tick rejection can't escape and become an
  // unhandled rejection — Node terminates the process on those by
  // default. The interval callback gets the same wrapper.
  intervalHandle = setInterval(safeTick, TICK_MS);
  void safeTick();
  console.log(
    `[core-recurrence] scheduler started — ticking every ${TICK_MS / 1000}s`,
  );
}

async function safeTick(): Promise<void> {
  try {
      // One process only: every api runs this loop, and more than one api
      // runs against a single database (the canary channel; a rolling deploy).
      // Unguarded, a recurring task is created twice on every due date.
    await platform().exclusive.run("core-recurrence.scheduler", async () => {
      await tick();
    });
  } catch (err) {
    console.error(
      "[core-recurrence] tick failed:",
      (err as Error).stack ?? (err as Error).message,
    );
  }
}

export function stopRecurrenceScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[core-recurrence] scheduler stopped");
  }
}

/** A single tick — for tests that want deterministic firing rather
 *  than waiting on the interval. opts.orgId narrows both the wire
 *  scan and the per-entity scan to one tenant (a tick fired from
 *  inside a workspace shouldn't iterate every other workspace). */
export async function tick(
  opts: { orgId?: string } = {},
): Promise<{ evaluated: number; fired: number }> {
  const now = new Date();
  const onlyOrg = opts.orgId;
  const meta = platform().db.meta as unknown as MetaDbLike;
  let wiresQuery = meta
    .selectFrom("entity_action_bindings")
    .leftJoin(
      "wire_schedule_state",
      "wire_schedule_state.binding_id",
      "entity_action_bindings.id",
    )
    .select([
      "entity_action_bindings.id",
      "entity_action_bindings.org_id",
      "entity_action_bindings.source_kind",
      "entity_action_bindings.trigger_schedule",
      "wire_schedule_state.last_fired_at",
    ])
    .where("entity_action_bindings.trigger_type", "=", "schedule")
    .where("entity_action_bindings.enabled", "=", true)
    .where("entity_action_bindings.trigger_schedule", "is not", null);
  if (onlyOrg) {
    wiresQuery = wiresQuery.where("entity_action_bindings.org_id", "=", onlyOrg);
  }
  const wires = (await wiresQuery.execute()) as Array<{
    id: string;
    org_id: string;
    source_kind: string;
    trigger_schedule: string | null;
    last_fired_at: Date | null;
  }>;

  let fired = 0;
  for (const w of wires) {
    if (!w.trigger_schedule) continue;
    try {
      const rule = rrulestr(w.trigger_schedule);
      const lower = w.last_fired_at ?? new Date(0);
      const occurrences = rule.between(
        new Date(lower.getTime() + 1),
        now,
        true,
      );
      if (occurrences.length === 0) continue;

      // Fire ONCE per tick even if multiple occurrences elapsed
      // (e.g. process down for an hour and a 5-minute RRULE racked
      // up 12 missed firings). Treating each as a separate fire is
      // rarely what the user wants. Latest-only; builders who want
      // every occurrence can declare a finer schedule.
      const fireAt = occurrences[occurrences.length - 1]!;
      await platform().events.emit("core-recurrence.rule.fired", {
        orgId: w.org_id,
        scheduleId: w.id,
        firedFor: fireAt.toISOString(),
        rrule: w.trigger_schedule,
      });
      await meta
        .insertInto("wire_schedule_state")
        .values({
          binding_id: w.id,
          last_fired_at: fireAt,
          next_due_at: rule.after(fireAt) ?? null,
        })
        .onConflict((b: OnConflictLike) =>
          b.column("binding_id").doUpdateSet({
            last_fired_at: fireAt,
            next_due_at: rule.after(fireAt) ?? null,
          }),
        )
        .execute();
      fired++;
    } catch (err) {
      console.error(
        `[core-recurrence] wire ${w.id} (rrule="${w.trigger_schedule}") failed:`,
        (err as Error).message,
      );
    }
  }
  // D3: scan entity-level recurrence declarations.
  const entityFired = await tickEntityRecurrence(now, onlyOrg);

  return { evaluated: wires.length, fired: fired + entityFired };
}

/** D3 per-entity recurrence: each scanner (registered by its owning
 *  module via platform.recurrence.registerScanner) returns rows of
 *  {entityId, rrule, title?, event} per tenant. We iterate every org
 *  through every scanner, evaluate each row's RRULE against last-fired
 *  state, and fire the row's event when due. Idempotent via
 *  core_recurrence_entity_state in cobblr_meta. */
async function tickEntityRecurrence(
  now: Date,
  onlyOrg?: string,
): Promise<number> {
  const scanners = platform().recurrence.listScanners();
  if (scanners.length === 0) return 0;

  const meta = platform().db.meta as unknown as MetaDbLike;
  let orgs: Array<{ id: string }>;
  if (onlyOrg) {
    // Tick called with a tenant scope (e.g. via the org-scoped
    // /tick HTTP endpoint). Skip the cross-tenant enumeration.
    orgs = [{ id: onlyOrg }];
  } else {
    // Background tick: scan "active" orgs only — those created in
    // the last 5 minutes OR already carrying recurrence state.
    // Avoids fanning scanners across thousands of dev-DB leftover
    // tenants and exhausting the pg connection pool. New tenants
    // get a 5-minute window to be picked up; after that, they need
    // at least one HTTP-triggered /tick to seed state (which then
    // keeps them in the recurring scan thereafter).
    const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const recentOrgs = (await meta
      .selectFrom("orgs")
      .select(["id"])
      .where("plan", "!=", "disabled")
      .where("created_at", ">", recentCutoff)
      .execute()) as unknown as Array<{ id: string }>;
    const statefulOrgs = (await meta
      .selectFrom("core_recurrence_entity_state")
      .select(["org_id"])
      .execute()) as unknown as Array<{ org_id: string }>;
    const orgIds = new Set<string>();
    for (const r of recentOrgs) orgIds.add(r.id);
    for (const r of statefulOrgs) orgIds.add(r.org_id);
    orgs = Array.from(orgIds).map((id) => ({ id }));
  }

  // Only run a kind's scanner where its owning module is actually enabled —
  // a scanner against an org that never enabled the module probes tables
  // that don't exist (relation "assets_assets" does not exist) and spammed
  // the log once per org per tick (console audit, 2026-06-11). One query
  // for the whole sweep.
  const enabledRows = (await meta
    .selectFrom("org_modules")
    .select(["org_id", "module_name"])
    .execute()) as unknown as Array<{ org_id: string; module_name: string }>;
  const enabledByOrg = new Map<string, Set<string>>();
  for (const r of enabledRows) {
    let set = enabledByOrg.get(r.org_id);
    if (!set) enabledByOrg.set(r.org_id, (set = new Set()));
    set.add(r.module_name);
  }

  let fired = 0;
  for (const org of orgs) {
    try {
    for (const { kind, scanner } of scanners) {
      // "assets:asset" → owning module "assets".
      const owningModule = kind.split(":")[0] ?? "";
      if (!enabledByOrg.get(org.id)?.has(owningModule)) continue;
      let rows;
      try {
        rows = await scanner(org.id);
      } catch (err) {
        console.error(
          `[core-recurrence] scanner ${kind} on org ${org.id} threw:`,
          (err as Error).message,
        );
        continue;
      }
      if (rows.length === 0) continue;

      const stateRows = (await meta
        .selectFrom("core_recurrence_entity_state")
        .select(["entity_id", "last_fired_at"])
        .where("org_id", "=", org.id)
        .where("kind", "=", kind)
        .execute()) as unknown as Array<{
          entity_id: string;
          last_fired_at: Date;
        }>;
      const lastFiredById = new Map(stateRows.map((r) => [r.entity_id, r.last_fired_at]));

      for (const row of rows) {
        if (typeof row.rrule !== "string" || row.rrule.length === 0) continue;
        try {
          const rule = rrulestr(row.rrule);
          const lower = lastFiredById.get(row.entityId) ?? new Date(0);
          const occurrences = rule.between(
            new Date(lower.getTime() + 1),
            now,
            true,
          );
          if (occurrences.length === 0) continue;
          const fireAt = occurrences[occurrences.length - 1]!;
          // Emit with BOTH the generic `entityId` key + the kind-
          // suffix-based key the wire engine derives from
          // source_kind ('assets:asset' → 'assetId'). Multi-word
          // kinds get camelCased to match the wire engine's lookup
          // ('purchases:order_item' → 'orderItemId').
          const suffix = kind.split(":")[1] ?? "";
          const camelSuffix = suffix.replace(/_([a-z])/g, (_, c: string) =>
            c.toUpperCase(),
          );
          const sourceIdKey = `${camelSuffix}Id`;
          await platform().events.emit(row.event, {
            orgId: org.id,
            kind,
            entityId: row.entityId,
            [sourceIdKey]: row.entityId,
            firedFor: fireAt.toISOString(),
            rrule: row.rrule,
            // Pass the entity's title for downstream wires that
            // want to render notifications without another resolver
            // lookup ("Water Cherry tomato (Bed 1, left)").
            entityTitle: row.title,
          });
          await meta
            .insertInto("core_recurrence_entity_state")
            .values({
              org_id: org.id,
              kind,
              entity_id: row.entityId,
              last_fired_at: fireAt,
              next_due_at: rule.after(fireAt) ?? null,
            })
            .onConflict((b: OnConflictLike) =>
              b.columns(["org_id", "kind", "entity_id"]).doUpdateSet({
                last_fired_at: fireAt,
                next_due_at: rule.after(fireAt) ?? null,
              }),
            )
            .execute();
          fired++;
        } catch (err) {
          console.error(
            `[core-recurrence] entity ${kind}:${row.entityId} (rrule="${row.rrule.slice(0, 40)}") failed:`,
            (err as Error).message,
          );
        }
      }
    }
    } finally {
      // Scanners open this org's tenant pool; release it (unless a live
      // request holds it) so a tick across every tenant doesn't exhaust
      // Postgres connections. Reopens lazily on next access.
      await platform().tenants.releaseIdleDb(org.id);
    }
  }
  return fired;
}

// ──────────────── Minimal Kysely surface (module local) ──────────────
//
// Defining a real Kysely<MetaDb> here would couple this module to api/
// schema types. We only need three operations (selectFrom-with-join,
// insertInto-with-onConflict), so we sketch a structural duck type.
// Lighter than pulling the api schema into the module's deps; safer
// than `any` because the call sites still get autocomplete-ish typing.

interface SelectBuilder {
  leftJoin(t: string, a: string, b: string): SelectBuilder;
  select(cols: string[]): SelectBuilder;
  where(col: string, op: string, val: unknown): SelectBuilder;
  execute(): Promise<unknown[]>;
}

interface OnConflictLike {
  column(c: string): {
    doUpdateSet(v: Record<string, unknown>): OnConflictLike;
  };
  columns(cols: string[]): {
    doUpdateSet(v: Record<string, unknown>): OnConflictLike;
  };
}

interface InsertBuilder {
  values(v: Record<string, unknown>): InsertBuilder;
  onConflict(fn: (b: OnConflictLike) => unknown): InsertBuilder;
  execute(): Promise<unknown>;
}

interface MetaDbLike {
  selectFrom(t: string): SelectBuilder;
  insertInto(t: string): InsertBuilder;
}
