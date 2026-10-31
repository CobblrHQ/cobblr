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
// The per-entity scan is a registered tenant sweep pass (registerEntityScan):
// the walk opens a workspace only when something there is due or has changed.
// It used to run on this timer over every workspace with a recurrence-owning
// module on, a fresh connection each, every minute: staging's database spent
// 90 minutes at 200-380% CPU starting them (#9013).
import rrulePkg from "rrule";
import { platform } from "@cobblr/platform-contract";
const { rrulestr } = rrulePkg;

// The platform's meta-DB accessor — we need cross-tenant reads of
// entity_action_bindings + wire_schedule_state. Use the platform's
// internal `meta` accessor via a typed eval-time import to keep this
// module from depending on api/ source paths.
//
// The schedule tick reads from cobblr_meta, not a tenant DB, so we
// can't go through a workspace's own database. The platform exposes
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
    // SKIP-IF-BUSY OK: a timer tick; the holder creates what is due, the next tick finds the rest
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
  // D3: entity-level recurrence. A tick scoped to one workspace scans it now;
  // the background scan is the core-recurrence.entity-scan sweep pass.
  const entityFired = onlyOrg ? await scanEntityRecurrence(onlyOrg, now) : 0;

  return { evaluated: wires.length, fired: fired + entityFired };
}

/** D3 per-entity recurrence for one workspace: each scanner (registered by
 *  its owning module via platform.recurrence.registerScanner) returns rows of
 *  {entityId, rrule, title?, event}; each row's RRULE is evaluated against
 *  last-fired state and its event fired when due. Idempotent via
 *  core_recurrence_entity_state in cobblr_meta. A rule first seen late fires
 *  its latest due occurrence, so finding it late never skips it. */
export async function scanEntityRecurrence(orgId: string, now: Date): Promise<number> {
  const scanners = platform().recurrence.listScanners();
  if (scanners.length === 0) return 0;
  const meta = platform().db.meta as unknown as MetaDbLike;
  const enabledRows = (await meta
    .selectFrom("org_modules")
    .select(["module_name"])
    .where("org_id", "=", orgId)
    .execute()) as unknown as Array<{ module_name: string }>;
  const enabled = new Set(enabledRows.map((r) => r.module_name));
  let fired = 0;
  try {
    for (const { kind, scanner } of scanners) {
      // "assets:asset" → owning module "assets".
      const owningModule = kind.split(":")[0] ?? "";
      if (!enabled.has(owningModule)) continue;
      let rows;
      try {
        rows = await scanner(orgId);
      } catch (err) {
        console.error(
          `[core-recurrence] scanner ${kind} on org ${orgId} threw:`,
          (err as Error).message,
        );
        platform().health.notePassFailure("core-recurrence.entity-scan", orgId, err);
        continue;
      }
      if (rows.length === 0) continue;

      const stateRows = (await meta
        .selectFrom("core_recurrence_entity_state")
        .select(["entity_id", "last_fired_at"])
        .where("org_id", "=", orgId)
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
            orgId: orgId,
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
              org_id: orgId,
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
          platform().health.notePassFailure("core-recurrence.entity-scan", `${orgId}:${row.entityId}`, err);
        }
      }
    }
  } finally {
    // Scanners open this org's tenant pool; release it (unless a live
    // request holds it). Reopens lazily on next access.
    await platform().tenants.releaseIdleDb(orgId);
  }
  scannedAt.set(orgId, now.getTime());
  return fired;
}

/** How long a workspace with nothing due and no activity goes between scans:
 *  a rule changed where the activity log does not see it (a restore, a
 *  script) is still found within this. */
export const RESCAN_MS = 6 * 60 * 60_000;
/** At most this many workspaces a round are scanned for being stale, so a
 *  restart (every workspace unscanned in this process) never opens them all
 *  at once: a large database is covered in rotation. */
export const STALE_PER_ROUND = 300;
const scannedAt = new Map<string, number>();
let rotation = 0;

/** The workspaces a recurrence round opens, from what meta already knows:
 *  any with an entity that came due since its last scan (a scan handles all
 *  that is due when it runs, so an entity that stays due, deleted or changed
 *  since, never reopens it), any with activity since its last scan (a rule
 *  added or changed: #7120's first watering on day two), and stale ones (never
 *  scanned in this process, or not in RESCAN_MS) a slice at a time. A
 *  workspace with nothing due and nothing changed is not opened. */
export function chooseRecurrenceWorkspaces(i: {
  eligible: string[];
  /** Per workspace, the latest next_due_at that has passed. */
  due: Map<string, number>;
  lastActivity: Map<string, number>;
  scannedAt: Map<string, number>;
  now: number;
  cursor?: { at: number };
}): string[] {
  const cursor = i.cursor ?? { get at() { return rotation; }, set at(v: number) { rotation = v; } };
  const chosen = new Set<string>();
  const stale: string[] = [];
  for (const id of [...i.eligible].sort()) {
    const scanned = i.scannedAt.get(id);
    if (scanned !== undefined && ((i.due.get(id) ?? 0) > scanned || (i.lastActivity.get(id) ?? 0) > scanned)) chosen.add(id);
    else if (scanned === undefined || i.now - scanned >= RESCAN_MS) stale.push(id);
  }
  if (stale.length <= STALE_PER_ROUND) stale.forEach((id) => chosen.add(id));
  else {
    const start = cursor.at % stale.length;
    cursor.at = (start + STALE_PER_ROUND) % stale.length;
    for (let k = 0; k < STALE_PER_ROUND; k++) chosen.add(stale[(start + k) % stale.length]!);
  }
  return [...chosen];
}

/** The background per-entity scan, on the tenant sweeps' walk. */
export function registerEntityScan(): void {
  platform().sweeps.register({
    name: "core-recurrence.entity-scan",
    everyMs: TICK_MS,
    candidates: async (orgIds, { named }) => {
      if (named) return orgIds;
      const scanners = platform().recurrence.listScanners();
      if (scanners.length === 0 || orgIds.length === 0) return [];
      const meta = platform().db.meta as unknown as MetaDbLike;
      const owning = new Set(scanners.map(({ kind }) => kind.split(":")[0] ?? ""));
      const modules = (await meta
        .selectFrom("org_modules")
        .select(["org_id", "module_name"])
        .where("org_id", "in", orgIds)
        .execute()) as unknown as Array<{ org_id: string; module_name: string }>;
      const eligible = [...new Set(modules.filter((m) => owning.has(m.module_name)).map((m) => m.org_id))];
      if (eligible.length === 0) return [];
      const now = Date.now();
      const due = (await meta
        .selectFrom("core_recurrence_entity_state")
        .select(["org_id", "next_due_at"])
        .where("org_id", "in", eligible)
        .where("next_due_at", "<=", new Date(now))
        .execute()) as unknown as Array<{ org_id: string; next_due_at: Date }>;
      const scannedIds = eligible.filter((id) => scannedAt.has(id));
      const since = scannedIds.length ? Math.min(...scannedIds.map((id) => scannedAt.get(id)!)) : now;
      const activity = scannedIds.length
        ? ((await meta
            .selectFrom("activity_log")
            .select(["org_id", "occurred_at"])
            .where("org_id", "in", scannedIds)
            .where("occurred_at", ">", new Date(since))
            .execute()) as unknown as Array<{ org_id: string; occurred_at: Date }>)
        : [];
      const lastActivity = new Map<string, number>();
      for (const a of activity) lastActivity.set(a.org_id, Math.max(lastActivity.get(a.org_id) ?? 0, new Date(a.occurred_at).getTime()));
      const dueAt = new Map<string, number>();
      for (const d of due) dueAt.set(d.org_id, Math.max(dueAt.get(d.org_id) ?? 0, new Date(d.next_due_at).getTime()));
      return chooseRecurrenceWorkspaces({ eligible, due: dueAt, lastActivity, scannedAt, now });
    },
    visit: async ({ orgId, now }) => {
      await scanEntityRecurrence(orgId, now);
    },
  });
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
