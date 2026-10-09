import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Selectable } from "kysely";
import type { TestRun } from "./production-store.js";
export function productionStatistics(runs: Selectable<TestRun>[]) {
 const first = new Map<string, Selectable<TestRun>>(), failures = new Map<string, number>(), groups = { operators: new Map<string, { tested: number; failed: number }>(), jigs: new Map<string, { tested: number; failed: number }>() };
 const values = new Map<string, { step: string; plan_id: string; plan_version: number; unit: string; min?: number; max?: number; values: number[] }>();
 for (const run of runs) {
  if (!run.result) continue;
  const key = `${run.unit_kind}:${run.unit_id}`;
  if (!first.has(key) || first.get(key)!.attempt > run.attempt) first.set(key, run);
  for (const step of run.result.steps) {
   if (step.result === "fail") { const key = `${run.plan_id}:v${run.plan_version}:${step.name}`; failures.set(key, (failures.get(key) ?? 0) + 1); }
   if (typeof step.value !== "number" || step.limits?.kind !== "range" || step.unit !== step.limits.unit) continue;
   const key = `${run.plan_id}:v${run.plan_version}:${step.id}`;
   const current = values.get(key) ?? { step: step.name, plan_id: run.plan_id, plan_version: run.plan_version, unit: step.unit, min: step.limits.min, max: step.limits.max, values: [] };
   current.values.push(step.value); values.set(key, current);
  }
  for (const [group, id] of [[groups.operators, run.operator_id], [groups.jigs, run.jig_id]] as const) {
   if (!id) continue;
   const totals = group.get(id) ?? { tested: 0, failed: 0 }; totals.tested++; if (run.result.status !== "passed") totals.failed++; group.set(id, totals);
  }
 }
 const tested = first.size, passed = [...first.values()].filter(r => r.result?.status === "passed").length;
 return { tested_units: tested, first_pass_units: passed, first_pass_yield: tested ? passed / tested : null,
  failure_pareto: [...failures].sort((a, b) => b[1] - a[1]).map(([step, failures]) => ({ step, failures })),
  spreads: [...values.values()].map(({ values, ...saved }) => { const mean = values.reduce((a, b) => a + b, 0) / values.length; const margin = saved.min !== undefined && saved.max !== undefined ? (saved.max - saved.min) * 0.1 : null; return { ...saved, count: values.length, minimum: Math.min(...values), maximum: Math.max(...values), mean, drift_warning: values.length >= 5 && margin !== null && (mean < saved.min! + margin || mean > saved.max! - margin) }; }),
  operator_failure_rates: [...groups.operators].map(([id, n]) => ({ id, ...n, rate: n.failed / n.tested })), jig_failure_rates: [...groups.jigs].map(([id, n]) => ({ id, ...n, rate: n.failed / n.tested })) };
}
export async function productionCertificate(runs: Selectable<TestRun>[], serials: Record<string, string>) {
 const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
 const clean = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
 for (const run of runs) {
  let page = pdf.addPage([595, 842]), y = 800;
  const line = (value: string, title = false) => {
   const words = clean(value).split(/\s+/); let row = "";
   const draw = () => { if (y < 50) { page = pdf.addPage([595, 842]); y = 800; } page.drawText(row, { x: 36, y, size: title ? 16 : 10, font: title ? bold : font, color: rgb(0.08, 0.12, 0.16) }); y -= title ? 26 : 16; row = ""; };
   for (const word of words) { const next = row ? row + " " + word : word; if (font.widthOfTextAtSize(next, title ? 16 : 10) > 515 && row) draw(); row = row ? row + " " + word : word; if (row.length > 90) { while (row.length > 90) { const rest = row.slice(90); row = row.slice(0, 90); draw(); row = rest; } } }
   if (row) draw();
  };
  line("Production test certificate", true);
  line(`Unit: ${run.unit_snapshot.serial ?? serials[run.unit_id] ?? run.unit_id}`);
  for (const [key, value] of Object.entries(run.unit_snapshot)) if (key !== "serial") line(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`); line(`Plan: ${run.plan.name}, version ${run.plan_version}, attempt ${run.attempt}`);
  line(`Result: ${run.result?.status ?? "unfinished"}`); line(`Plan SHA-256: ${run.plan_hash}`);
  line(`Run: ${run.id}`); line(`Operator: ${run.operator_id} | Station: ${run.station}`);
  line(`Jig: ${run.jig_id ?? "none"} | Cycle: ${run.jig_cycle ?? "none"}`);
  line(`Started: ${run.result?.started_at ?? "not started"} | Finished: ${run.result?.finished_at ?? "not finished"}`);
  for (const step of run.result?.steps ?? []) {
   line(`${step.name}: ${step.result} | ${step.value === undefined ? "" : String(step.value)} ${step.unit ?? ""}`, true);
   if (step.limits) line(`Limits: ${JSON.stringify(step.limits)}`);
   if (step.reason) line(step.reason);
   if (step.identity) line(`Instrument: ${step.identity} | Calibration due: ${step.calibration_due ?? "not recorded"}`);
   if (step.firmware_hash) line(`Firmware SHA-256: ${step.firmware_hash}`);
   for (const attachment of step.attachments ?? []) line(`${attachment.role}: ${attachment.filename}, file ${attachment.id}, SHA-256 ${attachment.sha256}`);
  }
  for (const output of run.result?.outputs_off ?? []) line(`${output.instrument}: ${output.confirmed ? "output off confirmed" : output.error ?? "output off not confirmed"}`);
 }
 return Buffer.from(await pdf.save());
}
