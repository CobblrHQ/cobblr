import type { TidyCandidate } from "@cobblr/platform-contract";
import { dayIn } from "@cobblr/platform-contract/day";
export function tidyNightDue(now: Date, last: Date | null, timezone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= 2 && hour < 5 && (!last || dayIn(last, timezone) !== dayIn(now, timezone));
}
export interface TidySuppression { kind: string; record_kind: string; record_id: string; until: Date | null }
export function visibleCandidate(c: TidyCandidate, suppressions: TidySuppression[], now: Date): boolean {
  return c.records.some((r) => !suppressions.some((s) => s.kind === c.kind && r.kind === s.record_kind && r.id === s.record_id && (s.until === null || s.until > now)));
}
export function allowedClassification(raw: unknown, collections: string[]): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { collection?: unknown; confidence?: unknown };
  return typeof r.collection === "string" && collections.includes(r.collection) && typeof r.confidence === "number" && r.confidence >= 0.85 && r.confidence <= 1 ? r.collection : null;
}
export function chooseTidyCandidates(candidates: TidyCandidate[], answer: unknown): TidyCandidate[] {
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const byId = new Map(ordered.map((c) => [c.id, c]));
  const selected: TidyCandidate[] = [];
  if (Array.isArray(answer)) for (const raw of answer) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { id?: unknown; line?: unknown };
    const c = typeof row.id === "string" ? byId.get(row.id) : undefined;
    if (!c || selected.some((s) => s.id === c.id)) continue;
    const line = typeof row.line === "string" ? row.line.trim() : "";
    selected.push({ ...c, why: line && line.length <= 240 && !/[\n\r\u2014]/.test(line) ? line : c.why });
    if (selected.length === 5) break;
  }
  for (const c of ordered) {
    if (selected.length === 5) break;
    if (!selected.some((s) => s.id === c.id)) selected.push(c);
  }
  return selected;
}
export async function runTidyNight(deps: { allowed: boolean; enabled: boolean; find: () => Promise<TidyCandidate[]>; rank: (candidates: TidyCandidate[]) => Promise<unknown>; save: (candidates: TidyCandidate[]) => Promise<void> }): Promise<void> {
  if (!deps.allowed || !deps.enabled) return;
  const candidates = await deps.find();
  let answer: unknown;
  if (candidates.length) try { answer = await deps.rank(candidates); } catch { /* Templates still deliver when no model can answer. */ }
  await deps.save(chooseTidyCandidates(candidates, answer));
}

export function withoutSuppressedRecords(c: TidyCandidate, suppressions: TidySuppression[], now: Date): TidyCandidate | null {
  const records = c.records.filter((r) => visibleCandidate({ ...c, records: [r] }, suppressions, now));
  if (!records.length || c.kind === "near-duplicate" && records.length < 2) return null;
  return { ...c, records, why: c.why.replace(/\b\d+\b/, String(records.length)), action: { ...c.action, ...(c.action.steps ? { steps: c.action.steps.map((step) => ({ ...step, args: { ...step.args, ids: (step.args.ids as string[]).filter((id) => records.some((r) => r.id === id)) } })).filter((step) => step.args.ids.length) } : {}), ...(c.action.args?.ids ? { args: { ...c.action.args, ids: records.map((r) => r.id) } } : {}) } };
}
