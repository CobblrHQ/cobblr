import { createHash } from "node:crypto";
import { z } from "zod";
import { unitWriteBytes } from "@cobblr/platform-contract/firmware-image";
import { AVR_FUSES, PROGRAMMERS } from "@cobblr/platform-contract/production-programmers";
import { PIN_EDGES, PIN_UNITS, PROBE_CHANNELS, PROBES, judgeLimits, judgeTargetRun, limitPattern, parseWord, planPins, stepChangesHardware } from "@cobblr/platform-contract/production-steps";

export { jigPinProblem, planPins, stepChangesHardware } from "@cobblr/platform-contract/production-steps";

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const text = z.string().max(200_000);
const scalar = z.union([z.number().finite(), text, z.boolean(), z.null()]);
const artifact = z.object({ file_id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const ref = z.object({ kind: z.string().min(3).max(160), id: z.string().uuid() }).strict();
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const address = z.number().int().min(0).max(0xffff_ffff);
const word = z.string().regex(/^0x[0-9a-fA-F]{1,8}$/);
const width = z.union([z.literal(8), z.literal(16), z.literal(32)]).default(32);
const chip = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);

export const ProductionLimits = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("range"), min: z.number().finite().optional(), max: z.number().finite().optional(), unit: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal("expected"), value: scalar, unit: z.string().min(1).max(32).optional() }).strict(),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(500), flags: z.enum(["", "i", "m", "im"]).default("") }).strict(),
]);
export type ProductionLimits = z.infer<typeof ProductionLimits>;
// What a debug probe does on the target. A value read back is a word: the
// target's IDCODE, a register, or what a write left there; `mask` picks the
// bits that must match.
export const ProbeAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("identify"), expect: word, mask: word.optional() }).strict(),
  z.object({ op: z.literal("read"), address, width, expect: word, mask: word.optional() }).strict(),
  z.object({ op: z.literal("write"), address, width, value: word, mask: word.optional() }).strict(),
  z.object({ op: z.literal("reset"), halt: z.boolean().default(false) }).strict(),
  // Test firmware already on the chip runs and prints `NAME [VALUE [UNIT]] PASS|FAIL` lines, then `done`.
  z.object({
    op: z.literal("run"), channel: z.enum(PROBE_CHANNELS), reset_first: z.boolean().default(true), done: z.string().trim().min(1).max(80).default("DONE"),
    // The serial port the firmware prints to, for the uart channel.
    uart_device: key.optional(), baud_rate: z.number().int().positive().max(2_000_000).default(115200),
    // Where OpenOCD looks for the RTT control block.
    rtt_search: z.object({ address, size: z.number().int().min(16).max(0x10_0000) }).strict().optional(),
    // The earlier program step whose ELF names the RTT control block, for probe-rs.
    symbols_from: key.optional(),
    // Lines the plan requires, with its own limits on their values; the firmware's own verdict is never enough on its own.
    checks: z.array(z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/), limits: ProductionLimits.optional(), required: z.boolean().default(true) }).strict()).max(64).default([]),
  }).strict(),
]);
export type ProbeAction = z.infer<typeof ProbeAction>;
const level = z.enum(["high", "low"]), window = z.number().int().min(10).max(10_000);
// What the fixture I/O controller does with a pin the jig names. Levels are
// the physical ones at the pin.
export const PinAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), pin: key, level }).strict(),
  z.object({ op: z.literal("pulse"), pin: key, level, width_us: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ op: z.literal("pwm"), pin: key, frequency_hz: z.number().int().min(1).max(1_000_000), duty_percent: z.number().min(0).max(100) }).strict(),
  z.object({ op: z.literal("read"), pin: key, expect: level }).strict(),
  z.object({ op: z.literal("count"), pin: key, edge: z.enum(PIN_EDGES).default("rising"), window_ms: window }).strict(),
  z.object({ op: z.literal("frequency"), pin: key, window_ms: window }).strict(),
  z.object({ op: z.literal("duty"), pin: key, window_ms: window }).strict(),
  // From one edge to another; with drive, the fixture makes the first edge on an output itself.
  z.object({ op: z.literal("interval"), from: key, from_edge: z.enum(["rising", "falling"]).default("rising"), to: key, to_edge: z.enum(["rising", "falling"]).default("rising"), drive: z.boolean().default(false), window_ms: window }).strict(),
]);
export type PinAction = z.infer<typeof PinAction>;
// One fixture pin on a jig: the net name plans use, the controller's GPIO number, its direction and pull.
export const ProductionJigPin = z.object({ name: key, gpio: z.number().int().min(0).max(63), direction: z.enum(["input", "output"]), pull: z.enum(["none", "up", "down"]).default("none") }).strict();
export const ProductionJigPins = z.array(ProductionJigPin).max(64).superRefine((pins, ctx) => {
  if (new Set(pins.map(p => p.name)).size !== pins.length) ctx.addIssue({ code: "custom", message: "Name each fixture pin once." });
  if (new Set(pins.map(p => p.gpio)).size !== pins.length) ctx.addIssue({ code: "custom", message: "Wire each GPIO to one net." });
});
const base = { id: key, name: z.string().trim().min(1).max(200), notes: z.string().max(8000).optional(), limits: ProductionLimits.optional(), timeout_ms: z.number().int().min(100).max(120_000).default(30_000), on_fail: z.enum(["stop", "continue"]).optional() };
export const ProductionStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("instrument"), instrument: key, operation: z.enum(["measure", "setpoint", "output-on", "output-off"]), quantity: key.optional(), voltage: z.number().finite().nonnegative().optional(), current_limit: z.number().finite().nonnegative().optional() }).strict(),
  z.object({ ...base, kind: z.literal("capture"), instrument: key, channels: z.string().min(1).max(200), sample_rate: z.number().int().positive().max(100_000_000), duration_ms: z.number().int().positive().max(10_000), trigger: z.string().max(200).optional(), decoder: z.enum(["uart", "i2c", "spi", "can", "onewire"]).optional() }).strict(),
  z.object({ ...base, kind: z.literal("serial"), device: key, baud_rate: z.number().int().positive().max(2_000_000).default(115200), write: z.string().max(65_536).optional(), ending: z.enum(["none", "lf", "cr", "crlf"]).default("none"), serial_from_value: z.boolean().default(false) }).strict(),
  z.object({
    ...base, kind: z.literal("program"), tool: z.enum(PROGRAMMERS), device: key,
    // image_sha256 is what the image puts on the chip (firmware-image.ts), pinned when the plan is saved, so a read-back is checked against it.
    firmware: artifact.extend({ format: z.enum(["bin", "hex", "elf", "uf2"]).optional(), image_sha256: hex64.optional() }),
    parameters: z.record(z.union([z.string().max(1000), z.number().finite(), z.boolean()])).default({}),
    // Where a raw BIN starts. The other formats carry their own addresses.
    load_address: address.optional(),
    erase: z.enum(["none", "chip"]).optional(),
    // "readback": the station reads every byte back over the probe and compares it with the image. Absent: the programmer's own verify.
    verify: z.enum(["readback", "tool"]).optional(),
    fuses: z.record(z.enum(AVR_FUSES), z.string().regex(/^0x[0-9a-fA-F]{2}$/)).optional(),
    // The unit's serial, written as zero-padded ASCII at a fixed address, then read back.
    unit_write: z.object({ address, length: z.number().int().min(1).max(64), memory: z.enum(["flash", "eeprom"]).default("flash") }).strict().optional(),
    timeout_ms: z.number().int().min(100).max(120_000).default(120_000),
  }).strict(),
  z.object({ ...base, kind: z.literal("probe"), tool: z.enum(PROBES), device: key, target: chip.optional(), action: ProbeAction, timeout_ms: z.number().int().min(100).max(120_000).default(30_000) }).strict(),
  z.object({ ...base, kind: z.literal("pin"), device: key.default("fixture"), action: PinAction }).strict(),
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
  // The "jig closed / board seated" check every step that changes hardware waits for.
  seated_step: key.optional(),
  // Bench camera evidence: a frame at the start and at each step's end, and a clip of the seconds before a failure.
  camera: z.object({ frames: z.boolean().default(true), clip_on_fail_s: z.number().int().min(0).max(10).default(0) }).strict().optional(),
}).strict();
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;

function checkLimits(limits: ProductionLimits | undefined, label: string) {
  if (limits?.kind === "range" && (limits.min === undefined && limits.max === undefined || limits.min !== undefined && limits.max !== undefined && limits.min > limits.max)) throw new Error(`Check the range for ${label}.`);
  if (limits?.kind === "regex") {
    try { limitPattern(limits); } catch { throw new Error(`Check the RE2 pattern for ${label}.`); }
  }
}
function checkProbeStep(step: Extract<ProductionStep, { kind: "probe" }>, earlier: ProductionStep[]) {
  const action = step.action;
  if (step.limits) throw new Error(`Set what ${step.name} expects on its probe action, not as pass limits.`);
  if (step.tool !== "openocd" && !step.target) throw new Error(`Give ${step.name} the target chip ${step.tool} connects to.`);
  if (action.op === "identify" && step.tool === "probe-rs") throw new Error(`Check ${step.name}'s IDCODE with OpenOCD or pyOCD, or read the chip's device-ID register with probe-rs.`);
  if (action.op === "reset" && action.halt && step.tool === "probe-rs") throw new Error(`Halt after ${step.name}'s reset with OpenOCD or pyOCD; probe-rs resets and runs.`);
  if (action.op === "read" || action.op === "write") {
    if (action.address % (action.width / 8) !== 0) throw new Error(`Align ${step.name}'s address to its ${action.width}-bit width.`);
    const widest = action.width === 32 ? 0xffff_ffff : 2 ** action.width - 1;
    for (const value of [action.op === "read" ? action.expect : action.value, action.mask]) if (value !== undefined && parseWord(value)! > widest) throw new Error(`${step.name} has a value wider than ${action.width} bits.`);
  }
  if (action.op !== "run") return;
  if (action.channel === "uart" && !action.uart_device) throw new Error(`Choose the serial port ${step.name}'s test firmware prints to.`);
  if (action.channel === "rtt" && step.tool === "openocd" && !action.rtt_search) throw new Error(`Give ${step.name} the RAM range OpenOCD searches for the RTT block.`);
  if (action.channel === "rtt" && step.tool === "probe-rs") {
    const source = earlier.find(s => s.id === action.symbols_from);
    if (source?.kind !== "program" || source.firmware.format !== undefined && source.firmware.format !== "elf") throw new Error(`Choose the earlier ELF program step whose symbols ${step.name} reads RTT from.`);
  }
  if (action.channel === "semihosting" && step.tool !== "openocd") throw new Error(`Run ${step.name} over RTT or UART with ${step.tool}, or choose OpenOCD for semihosting.`);
  if (new Set(action.checks.map(c => c.name)).size !== action.checks.length) throw new Error(`Name each of ${step.name}'s checks once.`);
  for (const check of action.checks) checkLimits(check.limits, `${step.name} ${check.name}`);
}
export function assertNoWirelessCredentialFields(value: unknown, path = ""): void {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (/^(?:(?:wifi|wlan)[_-]?)?(?:ssid|psk)$/i.test(name) || /^(?:wifi|wlan)[_-]?(?:password|passphrase)$/i.test(name) || /(?:^|\.)(?:wifi|wlan)(?:\.|$)/i.test(path) && /^(?:ssid|password|passphrase|psk)$/i.test(name)) throw new Error("Keep wireless network credentials in the device owner's provisioning tools.");
    assertNoWirelessCredentialFields(child, path ? `${path}.${name}` : name);
  }
}
function checkPinStep(step: Extract<ProductionStep, { kind: "pin" }>) {
  const action = step.action, unit = action.op in PIN_UNITS ? PIN_UNITS[action.op as keyof typeof PIN_UNITS] : undefined;
  if (!unit && step.limits) throw new Error(`Set what ${step.name} expects on its pin action, not as pass limits.`);
  if (unit && (step.limits?.kind !== "range" || step.limits.unit !== unit)) throw new Error(`Give ${step.name} a range in ${unit}.`);
  if (action.op === "interval" && action.from === action.to) throw new Error(`Time ${step.name} between two different pins.`);
}
function checkSeated(plan: ProductionPlan) {
  const changes = plan.steps.findIndex(stepChangesHardware);
  if (!plan.seated_step) {
    if (plan.steps.some(s => s.kind === "pin" && stepChangesHardware(s))) throw new Error("Choose the check that the jig is closed and the board seated before the plan drives pins.");
    return;
  }
  const at = plan.steps.findIndex(s => s.id === plan.seated_step), seat = plan.steps[at];
  if (!seat || !(seat.kind === "pin" && seat.action.op === "read" || seat.kind === "operator" && seat.response === "pass-fail")) throw new Error("Make the seated check a pin read or an operator pass or fail.");
  if (changes !== -1 && changes < at) throw new Error(`Move ${plan.steps[changes]!.name} after the seated check.`);
}
/** Every output a finished run must confirm off: the plan's controlled instruments, then each fixture's pins. */
export function productionOutputs(plan: ProductionPlan): string[] {
  return [...plan.controlled_instruments, ...new Set(plan.steps.flatMap(s => s.kind === "pin" ? [`${s.device}-pins`] : []))];
}
export function validateProductionPlan(raw: unknown): ProductionPlan {
  assertNoWirelessCredentialFields(raw);
  const plan = ProductionPlanSchema.parse(raw), controls = new Set(plan.controlled_instruments);
  if (Object.keys(plan.instruments).length > 16) throw new Error("Choose at most sixteen instruments for one plan.");
  if (controls.size !== plan.controlled_instruments.length || plan.steps.length !== new Set(plan.steps.map(step => step.id)).size) throw new Error("Give each step and controlled instrument a unique id.");
  if (plan.steps.filter(s => (s.kind === "serial" || s.kind === "operator") && s.serial_from_value).length > 1) throw new Error("Choose one check to read the board serial.");
  for (const instrument of controls) if (!Object.hasOwn(plan.instruments, instrument)) throw new Error("Declare every controlled instrument in this plan.");
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind === "probe") checkProbeStep(step, plan.steps.slice(0, index));
    if (step.kind === "pin") checkPinStep(step);
    if ((step.kind === "instrument" || step.kind === "capture") && !Object.hasOwn(plan.instruments, step.instrument)) throw new Error(`Choose the instrument for ${step.name}.`);
    if (step.kind === "instrument") {
      if (step.operation === "measure" && (!step.quantity || !step.limits)) throw new Error(`Give ${step.name} a measured quantity and limits.`);
      if (step.operation !== "measure" && !controls.has(step.instrument)) throw new Error(`Declare ${step.instrument} as controlled before changing its output.`);
      if (step.operation === "setpoint" && step.voltage === undefined && step.current_limit === undefined) throw new Error(`Give ${step.name} a voltage or current limit.`);
    }
    if (step.kind === "program") {
      if (step.verify === "readback" && (!step.firmware.image_sha256 || !step.firmware.format)) throw new Error(`Save ${step.name} again so its firmware read-back is pinned.`);
      if (step.fuses && step.tool !== "avrdude") throw new Error(`Set fuses on ${step.name} with avrdude; option bytes for other programmers are set with the vendor's own tools.`);
      if (step.fuses && !Object.keys(step.fuses).length) throw new Error(`Give ${step.name} at least one fuse, or leave fuses off.`);
      if (step.unit_write?.memory === "eeprom" && step.tool !== "avrdude") throw new Error(`Write ${step.name}'s serial to flash; only avrdude writes EEPROM here.`);
      if (step.unit_write && step.tool === "avrdude" && step.unit_write.memory !== "eeprom") throw new Error(`Write ${step.name}'s serial to EEPROM; avrdude cannot write one address of flash on its own.`);
      if (step.firmware.format === "bin" && step.load_address === undefined && step.parameters.offset === undefined) throw new Error(`Give ${step.name} the address its BIN image starts at.`);
    }
    if ((step.kind === "capture" || step.kind === "serial") && !step.limits) throw new Error(`Give ${step.name} limits or an expected reply.`);
    checkLimits(step.limits, step.name);
  }
  planPins(plan.steps);
  checkSeated(plan);
  const outputs = productionOutputs(plan);
  if (new Set(outputs).size !== outputs.length) throw new Error("Rename the controlled instrument that shares a fixture's name.");
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
  // What a read-back found on the chip, fingerprinted the way the plan pinned the image.
  readback_sha256: hex64.optional(),
  // The bytes written for this unit and where, as read back after writing.
  unit_write: z.object({ address, memory: z.enum(["flash", "eeprom"]), hex: z.string().regex(/^(?:[0-9a-f]{2}){1,64}$/) }).strict().optional(),
  attachments: z.array(z.object({ id: z.string().max(160), filename: z.string().max(200), mime_type: z.string().max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(["capture", "photo", "scope", "report", "camera", "clip"]) }).strict()).max(20).optional(),
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
  // Release every pin of one fixture I/O controller to its safe, high-impedance state.
  releasePins?(device: string): Promise<{ confirmed: boolean }>;
  // The bench camera's evidence: the start frame, or a step's end frame plus, when it failed, its clip.
  camera?(moment: "start" | ProductionStepResult): Promise<NonNullable<ProductionObservation["attachments"]>>;
}
export interface ProductionTestResult {
  plan: ProductionPlan; plan_hash: string; status: "passed" | "failed" | "aborted" | "error";
  steps: ProductionStepResult[]; outputs_off: Array<{ instrument: string; confirmed: boolean; error?: string }>;
  started_at: string; finished_at: string;
}
export function judgeProductionObservation(step: ProductionStep, observation: ProductionObservation, unit?: { serial?: string | null }): { result: "pass" | "fail"; reason?: string } {
  const limit = step.limits;
  if (observation.confirmed === false) return { result: "fail", reason: "The device did not confirm the operation." };
  if (step.kind === "program") {
    if (step.verify === "readback" && observation.readback_sha256 !== step.firmware.image_sha256) return { result: "fail", reason: "What was read back from the chip is not this firmware image." };
    if (step.unit_write) {
      const written = observation.unit_write;
      if (!written || written.address !== step.unit_write.address || written.memory !== step.unit_write.memory || written.hex.length !== step.unit_write.length * 2) return { result: "fail", reason: "The unit's serial was not read back where the plan writes it." };
      if (unit?.serial && written.hex !== Buffer.from(unitWriteBytes(unit.serial, step.unit_write.length)).toString("hex")) return { result: "fail", reason: "The serial read back from the board is not this unit's." };
    }
  }
  if (step.kind === "probe") return judgeProbe(step, observation);
  if (step.kind === "pin") return judgePin(step, observation);
  const judged = judgeLimits(limit, observation);
  if (judged) return judged;
  return observation.confirmed === true || observation.value !== undefined && observation.value !== false && observation.value !== null ? { result: "pass" } : { result: "fail", reason: "This step did not return a successful result." };
}
function judgeProbe(step: Extract<ProductionStep, { kind: "probe" }>, observation: ProductionObservation): { result: "pass" | "fail"; reason?: string } {
  const action = step.action;
  if (action.op === "reset") return observation.confirmed === true ? { result: "pass" } : { result: "fail", reason: "The probe did not confirm the reset." };
  if (action.op === "run") {
    if (typeof observation.value !== "string") return { result: "fail", reason: "The test firmware's output was not kept." };
    const { result, reason } = judgeTargetRun(action, observation.value);
    return reason ? { result, reason } : { result };
  }
  const got = parseWord(observation.value), mask = parseWord(action.mask ?? "0xffffffff")!, want = parseWord(action.op === "write" ? action.value : action.expect)!;
  if (got === null) return { result: "fail", reason: "The probe did not return a value." };
  if (((got & mask) >>> 0) === ((want & mask) >>> 0)) return { result: "pass" };
  return { result: "fail", reason: action.op === "identify" ? "The chip on this board is not the one this plan expects." : action.op === "write" ? "The value read back is not what was written." : "The register does not hold the expected value." };
}
function judgePin(step: Extract<ProductionStep, { kind: "pin" }>, observation: ProductionObservation): { result: "pass" | "fail"; reason?: string } {
  const action = step.action;
  if (action.op === "set" || action.op === "pulse" || action.op === "pwm") return observation.confirmed === true ? { result: "pass" } : { result: "fail", reason: "The fixture did not confirm the pin." };
  if (action.op === "read") return observation.value === action.expect ? { result: "pass" } : { result: "fail", reason: typeof observation.value === "string" ? `${action.pin} is ${observation.value}, not ${action.expect}.` : "The fixture did not read the pin." };
  if (action.op === "interval" && observation.value === null) return { result: "fail", reason: `${action.to} did not change within ${action.window_ms} ms.` };
  return judgeLimits(step.limits, observation) ?? { result: "fail", reason: "This step has no limits." };
}
const NOT_SEATED = "The jig is not closed or the board is not seated.";
function cameraFrames(moment: "start" | ProductionStepResult, got: ProductionObservation["attachments"]): NonNullable<ProductionObservation["attachments"]> {
  const frames = (got ?? []).filter(a => a.role === "camera" || a.role === "clip" && moment !== "start" && moment.result === "fail");
  if (!frames.some(a => a.role === "camera")) throw new Error("The bench camera did not return a frame.");
  return frames;
}
async function performStep(step: ProductionStep, io: ProductionTestPorts, parent?: AbortSignal): Promise<ProductionObservation> {
  const controller = new AbortController(), abort = () => controller.abort();
  const delay = step.kind === "wait" ? step.duration_ms + 5000 : step.timeout_ms;
  const timer = setTimeout(abort, delay);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    const work = io.perform(step, controller.signal);
    const changesHardware = stepChangesHardware(step);
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
export async function executeProductionTest(raw: unknown, io: ProductionTestPorts, options: { confirmed?: boolean; signal?: AbortSignal; now?: () => Date; unit?: { serial?: string | null } } = {}): Promise<ProductionTestResult> {
  const plan = frozen(validateProductionPlan(raw));
  const changesHardware = plan.steps.some(stepChangesHardware);
  if (changesHardware && options.confirmed !== true) throw new Error("Confirm this plan's control and programming steps before Start.");
  for (const instrument of plan.controlled_instruments) if (!await io.controlEnabled(instrument)) throw new Error(`Turn on control for ${instrument} before running this plan.`);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const result: ProductionTestResult = { plan, plan_hash: productionPlanHash(plan), status: "passed", steps: [], outputs_off: [], started_at: now(), finished_at: "" };
  let stopped = false, seated = !plan.seated_step, start: NonNullable<ProductionObservation["attachments"]> | Error = [];
  if (plan.camera) {
    try { start = cameraFrames("start", await io.camera?.("start")); } catch (error) { start = error instanceof Error ? error : new Error("The bench camera did not return a frame."); }
  }
  try {
    for (const step of plan.steps) {
      const started_at = now();
      let recorded: ProductionStepResult;
      if (options.signal?.aborted || stopped) recorded = { id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "skip", reason: options.signal?.aborted ? "The operator stopped this test." : "An earlier step failed.", started_at, finished_at: now() };
      else if (!seated && stepChangesHardware(step)) recorded = { id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "skip", reason: NOT_SEATED, started_at, finished_at: now() };
      else {
        try {
          const observation = await performStep(step, io, options.signal), judged = judgeProductionObservation(step, observation, options.unit);
          recorded = { ...observation, ...judged, id: step.id, name: step.name, kind: step.kind, limits: step.limits, started_at, finished_at: now() };
        } catch (error) {
          recorded = { id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "fail", reason: error instanceof Error ? error.message.slice(0, 3000) : "This step could not finish.", started_at, finished_at: now() };
        }
      }
      if (plan.camera && recorded.result !== "skip") recorded = await withCamera(recorded, io, result.steps.every(s => s.result === "skip") ? start : []);
      if (step.id === plan.seated_step) seated = recorded.result === "pass";
      if (recorded.result === "fail") { result.status = "failed"; stopped = (step.on_fail ?? plan.on_fail) === "stop"; }
      result.steps.push(frozen(recorded));
      await io.onStep?.(recorded);
    }
    if (options.signal?.aborted) result.status = "aborted";
  } catch (error) {
    result.status = options.signal?.aborted ? "aborted" : "error";
    for (const step of plan.steps.slice(result.steps.length)) result.steps.push({ id: step.id, name: step.name, kind: step.kind, limits: step.limits, result: "skip", reason: error instanceof Error ? error.message.slice(0, 3000) : "This test could not finish.", started_at: now(), finished_at: now() });
  } finally {
    result.outputs_off = await Promise.all(productionOutputs(plan).map(async instrument => {
      try {
        const pins = plan.controlled_instruments.includes(instrument) ? undefined : instrument.slice(0, -"-pins".length);
        if (pins !== undefined && !io.releasePins) throw new Error("This station cannot release the fixture's pins.");
        const reply = pins === undefined ? await io.outputOff(instrument) : await io.releasePins!(pins);
        return { instrument, confirmed: reply.confirmed === true, ...(reply.confirmed === true ? {} : { error: "The instrument did not confirm output off." }) };
      } catch (error) { return { instrument, confirmed: false, error: error instanceof Error ? error.message.slice(0, 3000) : "Output off could not be confirmed." }; }
    }));
    if (result.outputs_off.some(output => !output.confirmed)) result.status = "error";
    result.finished_at = now();
  }
  return frozen(result);
}
async function withCamera(recorded: ProductionStepResult, io: ProductionTestPorts, start: NonNullable<ProductionObservation["attachments"]> | Error): Promise<ProductionStepResult> {
  try {
    if (start instanceof Error) throw start;
    const attachments = [...start, ...recorded.attachments ?? [], ...cameraFrames(recorded, await io.camera?.(recorded))].slice(0, 20);
    return { ...recorded, attachments };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 3000) : "The bench camera did not return a frame.";
    return { ...recorded, result: "fail", reason: recorded.result === "fail" ? `${recorded.reason ?? "This step failed."} ${reason}` : reason };
  }
}
