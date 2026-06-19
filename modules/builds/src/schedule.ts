// Scheduling (rung 7) — a deliberate HEURISTIC, not a finite-capacity solver.
//
// Earliest-due-date (EDD) dispatch: within each lane (resource_label), order by
// due date (then priority), lay the work out back-to-back from `now`, and flag
// anything projected to finish after its due date. It does NOT solve capacity
// across lanes, setup/sequence-dependent times, splitting, or machine
// availability — that's the honest boundary (business-models/docs/22, rung 7).
// Pure + deterministic: `now` is injected so it's unit-testable.

export interface PlannedItem {
  id: string;
  build_id: string;
  build_name: string;
  qty: number;
  due_date: string | null; // YYYY-MM-DD
  priority: number;
  resource_label: string | null;
  /** Estimated minutes to make ONE (Σ operation est_minutes; 0 if unestimated). */
  est_minutes_each: number;
}

export interface ScheduledItem extends PlannedItem {
  est_minutes_total: number;
  projected_start: string; // ISO
  projected_finish: string; // ISO
  late: boolean;
}
export interface ScheduleLane {
  resource_label: string;
  items: ScheduledItem[];
  total_minutes: number;
  late_count: number;
}
export interface ScheduleResult {
  now: string;
  lanes: ScheduleLane[];
}

const UNASSIGNED = "Unassigned";

/** Due-date sort key — nulls (no due date) sort last. */
function dueKey(d: string | null): number {
  if (!d) return Number.POSITIVE_INFINITY;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export function scheduleEDD(items: PlannedItem[], nowIso: string): ScheduleResult {
  const nowMs = Date.parse(nowIso);
  const base = Number.isFinite(nowMs) ? nowMs : 0;

  // Group into lanes.
  const lanes = new Map<string, PlannedItem[]>();
  for (const it of items) {
    const key = it.resource_label?.trim() || UNASSIGNED;
    (lanes.get(key) ?? lanes.set(key, []).get(key)!).push(it);
  }

  const result: ScheduleLane[] = [];
  for (const [label, laneItems] of lanes) {
    // EDD within the lane: due asc (nulls last), then priority desc, then name.
    const ordered = [...laneItems].sort((a, b) => {
      const dk = dueKey(a.due_date) - dueKey(b.due_date);
      if (dk !== 0) return dk;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.build_name.localeCompare(b.build_name);
    });

    let cursor = base;
    let total = 0;
    let lateCount = 0;
    const scheduled: ScheduledItem[] = ordered.map((it) => {
      const each = Math.max(0, it.est_minutes_each) || 0;
      const totalMin = each * (it.qty > 0 ? it.qty : 0);
      const start = cursor;
      const finish = start + totalMin * 60_000;
      cursor = finish;
      total += totalMin;
      // Late if it finishes after the END of its due date (local-naive end of day).
      let late = false;
      if (it.due_date) {
        const dueEnd = Date.parse(`${it.due_date}T23:59:59Z`);
        late = Number.isFinite(dueEnd) && finish > dueEnd;
      }
      if (late) lateCount += 1;
      return {
        ...it,
        est_minutes_total: totalMin,
        projected_start: new Date(start).toISOString(),
        projected_finish: new Date(finish).toISOString(),
        late,
      };
    });

    result.push({ resource_label: label, items: scheduled, total_minutes: total, late_count: lateCount });
  }

  // Stable lane order: Unassigned last, others alphabetical.
  result.sort((a, b) => {
    if (a.resource_label === UNASSIGNED) return 1;
    if (b.resource_label === UNASSIGNED) return -1;
    return a.resource_label.localeCompare(b.resource_label);
  });

  return { now: new Date(base).toISOString(), lanes: result };
}
