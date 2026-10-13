import { eventually } from "./eventually.js";

export interface MakePrintView {
  make: { printer_name: string | null };
  steps: Array<{ step: string; status: string }>;
  print: { status: string; machine: { id: string } | null } | null;
}

export async function waitForRecordedPrint<T extends MakePrintView>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  // The job is committed before its Make step and printer links catch up.
  const ready = (value: T) => value.print?.status === "completed"
    && value.steps.some((step) => step.step === "print" && step.status === "done")
    && Boolean(value.print.machine?.id)
    && Boolean(value.make.printer_name);
  const result = await eventually(read, ready, timeoutMs);
  if (!ready(result)) {
    const last = {
      step_status: result.steps.find((step) => step.step === "print")?.status ?? null,
      job_status: result.print?.status ?? null,
      machine_id: result.print?.machine?.id ?? null,
      printer_name: result.make.printer_name,
    };
    throw new Error(`Make print result did not settle after ${timeoutMs}ms: ${JSON.stringify(last)}`);
  }
  return result;
}
