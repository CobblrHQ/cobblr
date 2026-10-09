import { createHash } from "node:crypto";
import { RE2JS } from "re2js";
import { z } from "zod";

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const text = z.string().max(200_000);
const scalar = z.union([z.number().finite(), text, z.boolean(), z.null()]);
const artifact = z.object({ file_id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const ref = z.object({ kind: z.string().min(3).max(160), id: z.string().uuid() }).strict();
export const ProductionLimits = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("range"), min: z.number().finite().optional(), max: z.number().finite().optional(), unit: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal("expected"), value: scalar, unit: z.string().min(1).max(32).optional() }).strict(),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(500), flags: z.enum(["", "i", "m", "im"]).default("") }).strict(),
]);
export type ProductionLimits = z.infer<typeof ProductionLimits>;
const base = { id: key, name: z.string().trim().min(1).max(200), notes: z.string().max(8000).optional(), limits: ProductionLimits.optional(), timeout_ms: z.number().int().min(100).max(120_000).default(30_000), on_fail: z.enum(["stop", "continue"]).optional() };
export const ProductionStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("instrument"), instrument: key, operation: z.enum(["measure", "setpoint", "output-on", "output-off"]), quantity: key.optional(), voltage: z.number().finite().nonnegative().optional(), current_limit: z.number().finite().nonnegative().optional() }).strict(),
  z.object({ ...base, kind: z.literal("capture"), instrument: key, channels: z.string().min(1).max(200), sample_rate: z.number().int().positive().max(100_000_000), duration_ms: z.number().int().positive().max(10_000), trigger: z.string().max(200).optional(), decoder: z.enum(["uart", "i2c", "spi", "can", "onewire"]).optional() }).strict(),
  z.object({ ...base, kind: z.literal("serial"), device: key, baud_rate: z.number().int().positive().max(2_000_000).default(115200), write: z.string().max(65_536).optional(), ending: z.enum(["none", "lf", "cr", "crlf"]).default("none"), serial_from_value: z.boolean().default(false) }).strict(),
  z.object({ ...base, kind: z.literal("program"), tool: z.enum(["openocd", "esptool", "avrdude", "picotool", "probe-rs"]), device: key, firmware: artifact, parameters: z.record(z.union([z.string().max(1000), z.number().finite(), z.boolean()])).default({}), timeout_ms: z.number().int().min(100).max(120_000).default(120_000) }).strict(),
  z.object({ ...base, kind: z.literal("operator"), photo_required: z.boolean().default(false), prompt: z.string().trim().min(1).max(8000), image_file_id: z.string().uuid().optional(), response: z.enum(["pass-fail", "number", "text", "scan"]), serial_from_value: z.boolean().default(false), timeout_ms: z.number().int().min(100).max(3_600_000).default(300_000) }).strict(),
  z.object({ ...base, kind: z.literal("wait"), duration_ms: z.number().int().nonnegative().max(600_000) }).strict(),
  z.object({ ...base, kind: z.literal("script"), framework: z.enum(["python", "openhtf"]).default("python"), script: artifact, devices: z.array(key).max(16).default([]), args: z.record(z.union([z.string().max(8000), z.number().finite(), z.boolean()])).default({}), measurement: key.optional(), timeout_ms: z.number().int().min(100).max(30_000).default(10_000) }).strict(),
]);
export type ProductionStep = z.infer<typeof ProductionStepSchema>;
export const ProductionPlanSchema = z.object({
  schema_version: z.literal(1).default(1), name: z.string().trim().min(1).max(200), version: z.number().int().positive(),
  product: ref.optional(), board_revision: ref.optional(), customer: ref.optional(),
  instruments: z.record(z.object({ connection_id: z.string().uuid(), device_id: z.string().min(1).max(200) }).strict()),
  controlled_instruments: z.array(key).max(16).default([]), steps: z.array(ProductionStepSchema).min(1).max(100),
  on_fail: z.enum(["stop", "continue"]).default("stop"), required_jig_id: z.string().uuid().optional(),
}).strict();
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;

function pattern(limits: Extract<ProductionLimits, { kind: "regex" }>) {
  const flags = (limits.flags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0) | (limits.flags.includes("m") ? RE2JS.MULTILINE : 0);
  return RE2JS.compile(limits.pattern, flags);
}
export function assertNoWirelessCredentialFields(value: unknown, path = ""): void {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (/^(?:(?:wifi|wlan)[_-]?)?(?:ssid|psk)$/i.test(name) || /^(?:wifi|wlan)[_-]?(?:password|passphrase)$/i.test(name) || /(?:^|\.)(?:wifi|wlan)(?:\.|$)/i.test(path) && /^(?:ssid|password|passphrase|psk)$/i.test(name)) throw new Error("Keep wireless network credentials in the device owner's provisioning tools.");
    assertNoWirelessCredentialFields(child, path ? `${path}.${name}` : name);
  }
}
export function validateProductionPlan(raw: unknown): ProductionPlan {
  assertNoWirelessCredentialFields(raw);
  const plan = ProductionPlanSchema.parse(raw), controls = new Set(plan.controlled_instruments);
  if (Object.keys(plan.instruments).length > 16) throw new Error("Choose at most sixteen instruments for one plan.");
  if (controls.size !== plan.controlled_instruments.length || plan.steps.length !== new Set(plan.steps.map(step => step.id)).size) throw new Error("Give each step and controlled instrument a unique id.");
  if (plan.steps.filter(s => (s.kind === "serial" || s.kind === "operator") && s.serial_from_value).length > 1) throw new Error("Choose one check to read the board serial.");
  for (const instrument of controls) if (!Object.hasOwn(plan.instruments, instrument)) throw new Error("Declare every controlled instrument in this plan.");
  for (const step of plan.steps) {
    if ((step.kind === "instrument" || step.kind === "capture") && !Object.hasOwn(plan.instruments, step.instrument)) throw new Error(`Choose the instrument for ${step.name}.`);
    if (step.kind === "instrument") {
      if (step.operation === "measure" && (!step.quantity || !step.limits)) throw new Error(`Give ${step.name} a measured quantity and limits.`);
      if (step.operation !== "measure" && !controls.has(step.instrument)) throw new Error(`Declare ${step.instrument} as controlled before changing its output.`);
      if (step.operation === "setpoint" && step.voltage === undefined && step.current_limit === undefined) throw new Error(`Give ${step.name} a voltage or current limit.`);
    }
    if ((step.kind === "capture" || step.kind === "serial") && !step.limits) throw new Error(`Give ${step.name} limits or an expected reply.`);
    if (step.limits?.kind === "range" && (step.limits.min === undefined && step.limits.max === undefined || step.limits.min !== undefined && step.limits.max !== undefined && step.limits.min > step.limits.max)) throw new Error(`Check the range for ${step.name}.`);
    if (step.limits?.kind === "regex") {
      try { pattern(step.limits); } catch { throw new Error(`Check the RE2 pattern for ${step.name}.`); }
    }
  }
  return plan;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, child]) => [name, canonical(child)]));
  return value;
}
export function productionPlanHash(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(validateProductionPlan(raw)))).digest("hex");
}
export const ProductionObservationSchema = z.object({
  value: scalar.optional(), unit: z.string().max(32).optional(), confirmed: z.boolean().optional(),
  identity: z.string().max(1000).optional(), calibration_due: z.string().max(80).nullable().optional(),
  measured_at: z.string().datetime().optional(), serial: z.string().min(1).max(160).optional(),
  firmware_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  attachments: z.array(z.object({ id: z.string().max(160), filename: z.string().max(200), mime_type: z.string().max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(["capture", "photo", "scope", "report"]) }).strict()).max(20).optional(),
}).strict();
export type ProductionObservation = z.infer<typeof ProductionObservationSchema>;
export interface ProductionStepResult extends ProductionObservation {
  id: string; name: string; kind: ProductionStep["kind"]; limits?: ProductionLimits;
  result: "pass" | "fail" | "skip"; reason?: string; started_at: string; finished_at: string;
}
export interface ProductionTestPorts {
  perform(step: ProductionStep, signal: AbortSignal): Promise<ProductionObservation>;
  outputOff(instrument: string): Promise<{ confirmed: boolean }>;
  controlEnabled(instrument: string): Promise<boolean>;
  onStep?(result: ProductionStepResult): Promise<void>;
}
export interface ProductionTestResult {
  plan: ProductionPlan; plan_hash: string; status: "passed" | "failed" | "aborted" | "error";
  steps: ProductionStepResult[]; outputs_off: Array<{ instrument: string; confirmed: boolean; error?: string }>;
  started_at: string; finished_at: string;
}
export function judgeProductionObservation(step: ProductionStep, observation: ProductionObservation): { result: "pass" | "fail"; reason?: string } {
  const limit = step.limits;
  if (observation.confirmed === false) return { result: "fail", reason: "The device did not confirm the operation." };
  if (limit?.kind === "range" || limit?.kind === "expected" && limit.unit !== undefined) {
    if (observation.unit !== limit.unit) return { result: "fail", reason: "The measured unit does not match this step's limits." };
  }
  if (limit?.kind === "range") {
    const value = observation.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return { result: "fail", reason: "The instrument did not return a finite measurement." };
    return limit.min !== undefined && value < limit.min || limit.max !== undefined && value > limit.max ? { result: "fail", reason: "The measurement is outside its limits." } : { result: "pass" };
  }
  if (limit?.kind === "expected") return observation.value === limit.value ? { result: "pass" } : { result: "fail", reason: "The value does not match the expected value." };
  if (limit?.kind === "regex") return typeof observation.value === "string" && pattern(limit).matcher(observation.value).find() ? { result: "pass" } : { result: "fail", reason: "The reply does not match the expected pattern." };
  return observation.confirmed === true || observation.value !== undefined && observation.value !== false && observation.value !== null ? { result: "pass" } : { result: "fail", reason: "This step did not return a successful result." };
}
async function performStep(step: ProductionStep, io: ProductionTestPorts, parent?: AbortSignal): Promise<ProductionObservation> {
  const controller = new AbortController(), abort = () => controller.abort();
  const delay = step.kind === "wait" ? step.duration_ms + 5000 : step.timeout_ms;
  const timer = setTimeout(abort, delay);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    const work = io.perform(step, controller.signal);
    const changesHardware = step.kind === "program" || step.kind === "script" || step.kind === "serial" && step.write !== undefined || step.kind === "instrument" && step.operation !== "measure";
    // A control must settle before cleanup, so an interrupted write cannot arrive after output off.
    if (changesHardware) {
      const answer = await work;
      if (controller.signal.aborted) throw new Error(parent?.aborted ? "The operator stopped this test." : "This step exceeded its time limit.");
      return ProductionObservationSchema.parse(answer);
    }
    return ProductionObservationSchema.parse(await new Promise<ProductionObservation>((resolve, reject) => {
      const interrupted = () => reject(new Error(parent?.aborted ? "The operator stopped this test." : "This step exceeded its time limit."));
      controller.signal.addEventListener("abort", interrupted, { once: true });
      if (controller.signal.aborted) interrupted();
      work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", interrupted));
    }));
  } finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); }
}
export async function executeProductionTest(raw: unknown, io: ProductionTestPorts, options: { confirmed?: boolean; signal?: AbortSignal; now?: () => Date } = {}): Promise<ProductionTestResult> {
  const plan = frozen(validateProductionPlan(raw));
  const changesHardware = plan.steps.some(step => step.kind === "program" || step.kind === "script" || step.kind === "serial" && step.write !== undefined || step.kind === "instrument" && step.operation !== "measure");
  if (changesHardware && options.confirmed !== true) throw new Error("Confirm this plan's control and programming steps before Start.");
  for (const instrument of plan.controlled_instruments) if (!await io.controlEnabled(instrument)) throw new Error(`Turn on control for ${instrument} before running this plan.`);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const result: ProductionTestResult = { plan, plan_hash: productionPlanHash(plan), status: "passed", steps: [], outputs_off: [], started_at: now(), finished_at: "" };
  let stopped = false;
  try {
    for (const step of plan.steps) {
      const started_at = now();
      let recorded: ProductionStepResult;
      if (options.signal?.aborted || stopped) recorded = { id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "skip", reason: options.signal?.aborted ? "The operator stopped this test." : "An earlier step failed.", started_at, finished_at: now() };
      else {
        try {
          const observation = await performStep(step, io, options.signal), judged = judgeProductionObservation(step, observation);
          recorded = { ...observation, ...judged, id: step.id, name: step.name, kind: step.kind, limits: step.limits, started_at, finished_at: now() };
        } catch (error) {
          recorded = { id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "fail", reason: error instanceof Error ? error.message.slice(0, 3000) : "This step could not finish.", started_at, finished_at: now() };
        }
      }
      if (recorded.result === "fail") { result.status = "failed"; stopped = (step.on_fail ?? plan.on_fail) === "stop"; }
      result.steps.push(frozen(recorded));
      await io.onStep?.(recorded);
    }
    if (options.signal?.aborted) result.status = "aborted";
  } catch (error) {
    result.status = options.signal?.aborted ? "aborted" : "error";
    for (const step of plan.steps.slice(result.steps.length)) result.steps.push({ id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "skip", reason: error instanceof Error ? error.message.slice(0, 3000) : "This test could not finish.", started_at: now(), finished_at: now() });
  } finally {
    result.outputs_off = await Promise.all(plan.controlled_instruments.map(async instrument => {
      try {
        const reply = await io.outputOff(instrument);
        return { instrument, confirmed: reply.confirmed === true, ...(reply.confirmed === true ? {} : { error: "The instrument did not confirm output off." }) };
      } catch (error) { return { instrument, confirmed: false, error: error instanceof Error ? error.message.slice(0, 3000) : "Output off could not be confirmed." }; }
    }));
    if (result.outputs_off.some(output => !output.confirmed)) result.status = "error";
    result.finished_at = now();
  }
  return frozen(result);
}
