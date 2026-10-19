// ──────────────── Pillar C runtime — wires + templates ─────────────

export interface PlatformTemplates {
  /** Render a template against a flat key/value map. Supports
   *  {{key}} substitution and {{key | default: "fallback"}} for
   *  empty values. Markdown-safe (no code execution). */
  render(template: string, data: Record<string, unknown>): string;
}

/** One enabled wire that would fire for an event, as a surface needs to say
 *  what a gesture is about to do ("+1 to stock when checked"). */
export interface WireEffect {
  binding_id: string;
  action_id: string;
  /** The action's label from the registry, for a generic rendering. */
  action_label: string | null;
  source_kind: string;
  args: Record<string, unknown> | null;
}

export interface PlatformWires {
  /** Called by an emitting module when an event fires. The wire
   *  engine looks up matching bindings + invokes their actions. */
  fireEvent(eventName: string, orgId: string, payload: Record<string, unknown>): Promise<void>;
  /** The enabled wires that WOULD fire for `eventName` on a record of
   *  `sourceKind`, so a surface can say what a gesture will do before it is
   *  made. Matches the way the engine matches: by the record's BASE kind, so
   *  a wire on `groceries:item` and one on `inventory:part` both count for
   *  either. Same action + args listed once, as the engine fires it once. */
  effectsOf(orgId: string, eventName: string, sourceKind: string): Promise<WireEffect[]>;
}

/** Health-probe primitive. Modules register a named probe at boot
 *  (typically from a lifecycle.onBoot hook); core-healthcheck
 *  aggregates them and exposes the rollup over HTTP. Each probe is
 *  a function returning a status string + an optional detail object.
 *  A probe that throws is treated as 'error' with the thrown
 *  message — the aggregator never propagates exceptions. */
export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthProbeResult {
  status: HealthStatus;
  detail?: Record<string, unknown>;
  message?: string;
}

export type HealthProbe = () => Promise<HealthProbeResult>;

export interface PlatformHealth {
  /** Register a probe by name. Idempotent — re-registering overrides
   *  the previous handler (useful for hot-reload in dev). */
  registerProbe(name: string, probe: HealthProbe): void;
  /** Snapshot all probes in parallel. Failed probes become
   *  { status: 'error', message: <err.message> } so the caller
   *  always gets a uniform shape. */
  snapshot(): Promise<Record<string, HealthProbeResult>>;
  /** A one-shot heal shim (a file carrying `DONE WHEN:`) records what one
   *  pass found, keyed by its own repo path: `found` is how much of its DONE
   *  WHEN was still untrue when it looked (candidates, not fixes: one it
   *  skipped still blocks deletion), `failed` the workspaces it could not
   *  read. The kernel keeps the date it last went clean (nothing found,
   *  nothing failed) and /healthz reports every shim, so the deletion
   *  condition is read over HTTPS on every deployment instead of from boot
   *  logs that leave with the container. Call it after EVERY whole pass that
   *  looked, one that found nothing included: silence is not zero. Never
   *  throws. */
  noteHealShim(shim: string, found: number, failed?: number): Promise<void>;
  /** A heal, reconcile or sweep pass caught a failure for one workspace (or
   *  module) and carried on. Record it here, never only in a log line: it is
   *  kept for /healthz, /readyz and tests, so "nothing happened" can never
   *  hide "it failed" (#4937). `scope` names what failed (an org id, a module).
   *  Never throws. lint:pass-failures-reported holds a pass's catches to it. */
  notePassFailure(pass: string, scope: string | null, err: unknown): void;
}

/** D3 — per-entity recurrence. Modules register a scanner per kind
 *  they want eligible for scheduled per-entity events. core-recurrence
 *  calls each scanner once per tick per tenant; the scanner returns
 *  rows of (entityId, rrule, title?) — module reads its own internal
 *  fields (no exposableFields projection) so private metadata is
 *  usable for scheduling.
 *
 *  Example registration (in modules/assets):
 *    platform().recurrence.registerScanner("assets:asset", async (orgId) => {
 *      const db = await platform().tenants.getDb(orgId);
 *      const rows = await db
 *        .selectFrom("assets_assets")
 *        .select(["id", "name", "metadata"])
 *        .execute();
 *      return rows
 *        .map((r) => ({
 *          entityId: r.id,
 *          rrule: (r.metadata as any)?.water_rrule,
 *          title: r.name,
 *          event: "assets.asset.recurred",
 *        }))
 *        .filter((r) => typeof r.rrule === "string" && r.rrule);
 *    });
 */
export interface RecurrentRow {
  entityId: string;
  rrule: string;
  title?: string;
  /** Event name to emit when this entity is due. Lets one kind
   *  fire different events for different sub-cases (water vs fertilize)
   *  by returning the same entity twice with different event names. */
  event: string;
}

export type RecurrenceScanner = (
  orgId: string,
) => Promise<RecurrentRow[]>;

export interface PlatformRecurrence {
  registerScanner(kind: string, scanner: RecurrenceScanner): void;
  listScanners(): Array<{ kind: string; scanner: RecurrenceScanner }>;
}
