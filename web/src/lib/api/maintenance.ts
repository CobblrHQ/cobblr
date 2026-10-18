import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import { browserTimeZone, request } from "./client";

export interface RenewalDocumentCandidate { kind: string; id: string; title: string; expiry: string | null; values: PersonalDocumentRead["fields"] }
export interface RenewalDocumentPlan {
  type: { id: string; label: string; expiryField: string; folder: string; recordLabel: string };
  candidates: RenewalDocumentCandidate[];
  records: RenewalDocumentCandidate[];
  collections: Array<{ kind: string; label: string; fields: Record<string, { name: string; type: string; native: boolean }>; titleField: string }>;
  complete: boolean;
  matched: { kind: string; id: string } | null;
}

export interface MaintenanceEntry {
  attachments?: Array<{ fileId: string; filename: string }>;
  nag_stopped_at: string | null;
  nag_snoozed_until: string | null;
  schedule?: MaintenanceSchedule | null;
  id: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  description: string | null;
  performed_at: string | null;
  scheduled_at: string | null;
  cost_cents: number | null;
  performed_by: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  /** The schedule this entry is an occurrence of. */
  schedule_id?: string | null;
  /** The name of the record this is for; null when it is no longer there. */
  entity_title?: string | null;
  /** Where an open entry stands, counted by the server in this browser's
   *  zone with the rule the record's schedule uses. `days` is negative when
   *  overdue. Absent on history. */
  due?: { state: "ok" | "due-soon" | "overdue"; reason: string; days: number };
  created_at: string;
  updated_at: string;
}

export type MaintenanceIntervalUnit = "day" | "week" | "month" | "year";

export type OverdueCadence = "day" | "week" | "month" | "off";
export type RenewalAnchor = string | { month: number; last_day: true };
export type MaintenanceReminder = { before: number; unit: "day" | "week" | "month" } | { on: "month_start" };

export interface MaintenanceTermPatch {
  term_start?: string; term_end?: string; cost_cents?: number | null; currency?: string;
  reference?: string | null; quantity?: number | null; file_id?: string;
}
export interface MaintenanceTerm extends MaintenanceEntry {
  is_term: true; term_start: string | null; term_end: string | null; currency: string | null;
  reference: string | null; quantity: number | null; previous_term_id: string | null; renewed_by: string | null;
}
export interface MaintenanceTermTotals {
  lifetime: Array<{ currency: string; cost_cents: number }>;
  per_year: Array<{ year: number; currency: string; cost_cents: number }>;
}

export interface MaintenanceSchedule {
  cancel_by?: string | null;
  initial_term?: { id: string; cost_cents?: number | null; currency?: string; quantity?: number | null } | null;
  ended_at: string | null;
  renewal_status: "active" | "lapsed" | "ended";
  latest_term: Pick<MaintenanceTerm, "id" | "term_start" | "term_end" | "cost_cents" | "currency" | "quantity"> | null;
  overdue_every: OverdueCadence | null;
  occurrence: { id: string; nag_stopped_at: string | null; nag_snoozed_until: string | null } | null;
  anchor: RenewalAnchor | null;
  remind: MaintenanceReminder | null;
  expiry_field: string | null;
  current_expiry: string | null;
  next_expiry: string | null;
  reminder_at: string | null;
  next_reminder_at: string | null;
  id: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  every_n: number | null;
  every_unit: MaintenanceIntervalUnit | null;
  counter_field: string | null;
  counter_every: number | null;
  last_done_at: string | null;
  last_done_counter: number | null;
  /** The rule in words: "every 3 months", "every 200 print hours". */
  rule: string;
  due: {
    state: "ok" | "due-soon" | "overdue";
    reason: string;
    next_due_at: string | null;
    next_due_counter: number | null;
    counter: number | null;
    counter_label: string;
  };
}

export const maintenanceApi = {
  planRenewalDocument: (slug: string, documentType: string, fields: PersonalDocumentRead["fields"]) =>
    request<RenewalDocumentPlan>("POST", `/orgs/${slug}/modules/core-maintenance/document-renewals/plan`, { document_type: documentType, fields }),

  // ─── core-maintenance (workspace-wide service log) ────────────────
  listMaintenance: (
    slug: string,
    params?: {
      kind?: "history" | "scheduled" | "all";
      due_within_days?: number;
      limit?: number;
      /** One record's entries (its service history). */
      entity_id?: string;
    },
  ) => {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set("kind", params.kind);
    if (params?.entity_id) qs.set("entity_id", params.entity_id);
    if (params?.due_within_days != null)
      qs.set("due_within_days", String(params.due_within_days));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const tz = browserTimeZone();
    if (tz) qs.set("tz", tz);
    const q = qs.toString();
    return request<{ items: MaintenanceEntry[] }>(
      "GET",
      `/orgs/${slug}/modules/core-maintenance/entries${q ? `?${q}` : ""}`,
    );
  },
  updateMaintenance: (
    slug: string,
    id: string,
    body: Partial<{
      name: string;
      description: string | null;
      performed_at: string | null;
      scheduled_at: string | null;
      cost_cents: number | null;
      notes: string | null;
      recurrence_rule: string | null;
    }>,
  ) =>
    request<MaintenanceEntry>(
      "PATCH",
      `/orgs/${slug}/modules/core-maintenance/entries/${id}`,
      body,
    ),
  completeMaintenance: (slug: string, id: string, performed_at?: string) =>
    request<MaintenanceEntry>(
      "POST",
      `/orgs/${slug}/modules/core-maintenance/entries/${id}/complete`,
      performed_at ? { performed_at } : {},
    ),
  deleteMaintenance: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-maintenance/entries/${id}`,
    ),
  // Recurring schedules on a record ("service every 3 months / 200 print hours").
  listMaintenanceSchedules: (slug: string, entityId: string) =>
    request<{ items: MaintenanceSchedule[] }>(
      "GET",
      `/orgs/${slug}/modules/core-maintenance/schedules?entity_id=${encodeURIComponent(entityId)}${browserTimeZone() ? `&tz=${encodeURIComponent(browserTimeZone()!)}` : ""}`,
    ),
  maintenanceCounters: (slug: string, kind: string, entityId: string) =>
    request<{ counters: Array<{ key: string; label: string; value: number | null }> }>(
      "GET",
      `/orgs/${slug}/modules/core-maintenance/schedules/counters?kind=${encodeURIComponent(kind)}&entity_id=${encodeURIComponent(entityId)}`,
    ),
  /** The jobs this kind of record has had, and the ones its table ships with. */
  maintenanceServiceNames: (slug: string, kind: string) =>
    request<{ values: Array<{ value: string; uses: number; lastUsed: string | null }>; suggested: string[] }>(
      "GET",
      `/orgs/${slug}/modules/core-maintenance/schedules/names?kind=${encodeURIComponent(kind)}`,
    ),
  createMaintenanceSchedule: (
    slug: string,
    body: {
      entity_module: string;
      entity_type: string;
      entity_id: string;
      name: string;
      every_n?: number | null;
      every_unit?: MaintenanceIntervalUnit | null;
      counter_field?: string | null;
      counter_every?: number | null;
      last_done_at?: string | null;
      anchor?: RenewalAnchor | null;
      remind?: MaintenanceReminder | null;
      overdue_every?: OverdueCadence | null;
      expiry_field?: string | null;
      current_expiry?: string | null;
    },
  ) => request<MaintenanceSchedule>("POST", `/orgs/${slug}/modules/core-maintenance/schedules`, body),
  maintenanceReminderPreferences: (slug: string) => request<{ overdue_every: OverdueCadence }>("GET", `/orgs/${slug}/modules/core-maintenance/reminders/preferences`),
  setMaintenanceReminderPreferences: (slug: string, overdue_every: OverdueCadence) => request<{ overdue_every: OverdueCadence }>("PUT", `/orgs/${slug}/modules/core-maintenance/reminders/preferences`, { overdue_every }),
  maintenanceRenewalFields: (slug: string, kind: string, entityId: string) => request<{ fields: Array<{ key: string; label: string; value: string | null }> }>("GET", `/orgs/${slug}/modules/core-maintenance/schedules/renewal-fields?kind=${encodeURIComponent(kind)}&entity_id=${encodeURIComponent(entityId)}`),
  renewMaintenanceSchedule: (slug: string, id: string, body: MaintenanceTermPatch & { new_expiry: string; file_id?: string; notes?: string | null }) => request<{ entry: { id: string }; schedule: MaintenanceSchedule }>("POST", `/orgs/${slug}/modules/core-maintenance/schedules/${id}/renew`, body),
  listMaintenanceTerms: (slug: string, entityId: string, offset = 0) => request<{ items: MaintenanceTerm[]; has_more: boolean; totals: MaintenanceTermTotals }>("GET", `/orgs/${slug}/modules/core-maintenance/terms?entity_id=${encodeURIComponent(entityId)}&offset=${offset}`),
  endMaintenanceRenewal: (slug: string, id: string) => request<MaintenanceSchedule>("POST", `/orgs/${slug}/modules/core-maintenance/schedules/${id}/end`, {}),
  deleteMaintenanceSchedule: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-maintenance/schedules/${id}`),
  /** Log a service. With a schedule_id it is that schedule's, which rolls it
   *  forward to the next time. */
  logMaintenance: (
    slug: string,
    body: {
      entity_module: string;
      entity_type: string;
      entity_id: string;
      name: string;
      performed_at: string;
      schedule_id?: string;
      notes?: string | null;
      cost_cents?: number | null;
    },
  ) => request<MaintenanceEntry>("POST", `/orgs/${slug}/modules/core-maintenance/entries`, body),
  /** What the ledger knows about an item: the learned rate, what is probably
   *  left, and what a purchase right now would MEAN (`repurchase_means`), which
   *  is what decides whether a re-scan needs the over-buy question. */
  cadenceState: (slug: string, kind: string, id: string, opts?: { expired?: boolean }) =>
    request<{
      /** Units per day, learned. Named cadence_rate by the engine - this type
       *  is the contract with a real response, not a guess. */
      cadence_rate: number | null;
      on_hand_estimate: number;
      days_until_runout: number | null;
      waste_ratio: number;
      confidence: string;
      reorder_suggested: boolean;
      buy_less_suggested: boolean;
      repurchase_means: "discard" | "consume" | "ask_over_buy";
      event_count: number;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-cadence/state/${encodeURIComponent(kind)}/${id}${opts?.expired ? "?expired=true" : ""}`,
    ),
};
