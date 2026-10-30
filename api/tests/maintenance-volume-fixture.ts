import { mapLimit } from "./map-limit.js";
import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { worn } from "../../scripts/lib/load-factor.mjs";
import { http, org, signupFreshOrg, type TestSession } from "./helpers.js";

export type Schedule = { id: string; name: string; every_n: number; current_expiry: string | null; ended_at: string | null; occurrence: { id: string } | null };
export type Entry = { id: string; name: string; schedule_id: string | null; scheduled_at: string | null; performed_at: string | null; notes: string | null; nag_stopped_at: string | null; nag_snoozed_until: string | null; cost_cents: number | null };
export type Term = { id: string; schedule_id: string; cost_cents: number | null; reference: string | null; term_start: string; term_end: string };
export type Outcome = { result: { ok: boolean; error?: string }; undo?: Array<{ action_id: string; args: Record<string, unknown> }> };

/** A workspace whose "Other machine" carries 120 paid renewals, a fresh
 *  "Chosen machine" for every test, and a check after each that none of the
 *  other machine's renewals, reminders or payments moved. Each file that uses
 *  it pays the setup once, so keep a file to a few tests (#8927). */
export function maintenanceVolume(shape: "fresh" | "volume" = "volume") {
  let session: TestSession;
  let target: string;
  let other: string;
  let saved: unknown;
  const count = shape === "volume" ? 120 : 1;
  const path = (suffix: string) => org(session, `/modules/core-maintenance/${suffix}`);
  const machine = async (name: string) => (await http<{ id: string }>(session, org(session, "/modules/machines/machines"), { method: "POST", body: { name } })).id;
  const list = async <T>(resource: string, id: string, extra = "") => (await http<{ items: T[] }>(session, path(`${resource}?entity_id=${id}&limit=200${extra}`))).items;
  const schedules = (id = target) => list<Schedule>("schedules", id);
  const entries = (kind: "history" | "scheduled", id = target) => list<Entry>("entries", id, `&kind=${kind}`);
  const terms = (id = target) => list<Term>("terms", id);
  const createSchedule = (id = target, renewal = false, name = "Oil change") => http<Schedule>(session, path("schedules"), { method: "POST", expectStatus: 201, body: {
    entity_module: "machines", entity_type: "machine", entity_id: id, name,
    ...(renewal ? { anchor: "11-30", current_expiry: "2090-11-30" } : { every_n: 3, every_unit: "month", last_done_at: "2026-01-10" }),
    overdue_every: "off",
  } });
  const press = async (action: string, args: Record<string, unknown>, onRecord = false) => {
    const outcome = await http<Outcome>(session, org(session, "/actions/invoke"), { method: "POST", body: {
      actionId: `core-maintenance:${action}`, args, ...(onRecord ? { entityKind: "machines:machine", entityId: target } : {}),
    } });
    expect(outcome.result.ok, outcome.result.error).toBe(true);
    return outcome;
  };
  const undo = async (outcome: Outcome) => {
    expect(outcome.undo).toHaveLength(1);
    const step = outcome.undo![0]!;
    const restored = await http<Outcome>(session, org(session, "/actions/invoke"), { method: "POST", body: { actionId: step.action_id, args: step.args } });
    expect(restored.result.ok, restored.result.error).toBe(true);
  };
  const snapshot = async () => ({
    schedules: (await schedules(other)).map(s => ({ id: s.id, name: s.name, current_expiry: s.current_expiry, ended_at: s.ended_at, occurrence: s.occurrence?.id })).sort((a, b) => a.id.localeCompare(b.id)),
    scheduled: (await entries("scheduled", other)).map(e => ({ id: e.id, schedule_id: e.schedule_id, scheduled_at: e.scheduled_at, nag_stopped_at: e.nag_stopped_at, nag_snoozed_until: e.nag_snoozed_until })).sort((a, b) => a.id.localeCompare(b.id)),
    terms: (await terms(other)).map(t => ({ id: t.id, schedule_id: t.schedule_id, cost_cents: t.cost_cents, reference: t.reference, term_start: t.term_start, term_end: t.term_end })).sort((a, b) => a.id.localeCompare(b.id)),
  });

  beforeAll(async () => {
    session = await signupFreshOrg(`maintenance-${shape}`);
    other = await machine("Other machine");
    // A renewal holds a transaction while its parent resolver borrows another tenant connection.
    await mapLimit(Array.from({ length: count }, (_, i) => i), 2, async (i) => {
      const schedule = await createSchedule(other, true, `Other renewal ${i}`);
      await http(session, path(`schedules/${schedule.id}/renew`), { method: "POST", body: { new_expiry: "2091-11-30", cost_cents: 1000 + i, reference: `Paid ${i}` } });
    });
    saved = await snapshot();
    const baseline = saved as Awaited<ReturnType<typeof snapshot>>;
    expect(baseline.schedules).toHaveLength(count);
    expect(baseline.scheduled).toHaveLength(count);
    expect(baseline.terms).toHaveLength(count);
  }, worn(180_000));
  beforeEach(async () => { target = await machine("Chosen machine"); });
  afterEach(async () => { expect(await snapshot(), "unrelated renewals, reminders and payments stay unchanged").toEqual(saved); });

  return {
    session: () => session,
    target: () => target,
    path, schedules, entries, terms, createSchedule, press, undo,
  };
}
