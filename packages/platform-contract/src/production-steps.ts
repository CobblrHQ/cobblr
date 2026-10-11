// Facts about production test steps that the browser needs as much as the
// station: which debug probes a plan may name, which steps touch the hardware,
// and how on-target test firmware reports its results. Kept apart from
// production-test.ts, which needs node:crypto.
import { RE2JS } from "re2js";

/** The debug probes a plan may drive over SWD or JTAG. */
export const PROBES = ["openocd", "probe-rs", "pyocd"] as const;
export type Probe = (typeof PROBES)[number];

/** Where on-target test firmware writes its result lines. */
export const PROBE_CHANNELS = ["rtt", "semihosting", "uart"] as const;
export type ProbeChannel = (typeof PROBE_CHANNELS)[number];

/** What a fixture I/O controller does with a pin: the first three drive it,
 *  the rest watch it. */
export const PIN_OPS = ["set", "pulse", "pwm", "read", "count", "frequency", "duty", "interval"] as const;
export type PinOp = (typeof PIN_OPS)[number];
export const PIN_EDGES = ["rising", "falling", "both"] as const;
/** The unit each measuring pin step reports, which its limits must use. */
export const PIN_UNITS = { count: "edges", frequency: "Hz", duty: "%", interval: "ms" } as const;

type PinActionShape = { op: string; pin?: string; from?: string; to?: string; drive?: boolean };
type StepShape = { id?: string; kind: string; operation?: string; write?: string; response?: string; action?: PinActionShape };

/** A pin step that drives the board through the fixture rather than only watching it. */
export function pinStepDrives(action: PinActionShape | undefined): boolean {
  return action?.op === "set" || action?.op === "pulse" || action?.op === "pwm" || action?.op === "interval" && action.drive === true;
}

/** A step that changes the board or an output. Start asks the operator to
 *  confirm these, each one settles before cleanup turns outputs off, and none
 *  of them runs before the plan's seated check passes. */
export function stepChangesHardware(step: StepShape): boolean {
  if (step.kind === "program" || step.kind === "script") return true;
  if (step.kind === "serial") return step.write !== undefined;
  if (step.kind === "instrument") return step.operation !== "measure";
  if (step.kind === "probe") return step.action?.op !== "identify" && step.action?.op !== "read";
  if (step.kind === "pin") return pinStepDrives(step.action);
  return false;
}

/** A fixture pin as the jig wires it: the plan's net name on a controller GPIO. */
export interface JigPin { name: string; gpio: number; direction: "input" | "output"; pull: "none" | "up" | "down" }

/** Every fixture pin a plan uses, by net name, and whether it drives or reads it. */
export function planPins(steps: StepShape[]): Array<{ name: string; direction: "input" | "output" }> {
  const found = new Map<string, "input" | "output">();
  const use = (name: string | undefined, direction: "input" | "output") => {
    if (!name) return;
    if (found.has(name) && found.get(name) !== direction) throw new Error(`Use ${name} as an input or an output, not both.`);
    found.set(name, direction);
  };
  for (const step of steps) {
    if (step.kind !== "pin" || !step.action) continue;
    const action = step.action;
    if (action.op === "interval") { use(action.from, action.drive ? "output" : "input"); use(action.to, "input"); }
    else use(action.pin, pinStepDrives(action) ? "output" : "input");
  }
  return [...found].map(([name, direction]) => ({ name, direction }));
}

/** Why a jig cannot run a plan's pin steps, or null when its pin list covers them. */
export function jigPinProblem(pins: JigPin[], steps: StepShape[]): string | null {
  for (const used of planPins(steps)) {
    const wired = pins.find(pin => pin.name === used.name);
    if (!wired) return `Map ${used.name} to a fixture pin on this jig.`;
    if (wired.direction !== used.direction) return `Wire ${used.name} as an ${used.direction} on this jig; the plan ${used.direction === "output" ? "drives" : "reads"} it.`;
  }
  return null;
}

/** One line of a target's own test report: `ADC_VREF 1.198 V PASS`. */
export interface TargetResultLine { name: string; value?: number | string; unit?: string; verdict: "PASS" | "FAIL" }

const LINE = /^\s*([A-Za-z][A-Za-z0-9_.-]{0,79})(?:\s+(\S{1,80}))?(?:\s+(\S{1,32}))?\s+(PASS|FAIL)\s*$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Read the result lines out of what test firmware printed. Anything that is
 *  not a result line is log output and is ignored; `done` says whether the
 *  firmware printed its end line, so a board that hung halfway never passes. */
export function parseTargetResults(text: string, doneLine: string): { lines: TargetResultLine[]; done: boolean } {
  const lines: TargetResultLine[] = [];
  let done = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === doneLine) { done = true; continue; }
    if (done || lines.length >= 256) continue;
    const match = LINE.exec(raw);
    if (!match) continue;
    const [, name, value, unit, verdict] = match;
    lines.push({ name: name!, ...(value === undefined ? {} : { value: NUMBER.test(value) ? Number(value) : value }), ...(unit === undefined ? {} : { unit }), verdict: verdict as "PASS" | "FAIL" });
  }
  return { lines, done };
}

/** A 32-bit word as the plan and the station write it: lowercase, 0x and eight digits. */
export function formatWord(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

/** A word from a plan or a probe's reply, or null when it is not one. */
export function parseWord(text: unknown): number | null {
  if (typeof text !== "string" || !/^0x[0-9a-fA-F]{1,8}$/.test(text.trim())) return null;
  return parseInt(text.trim(), 16) >>> 0;
}

type Limits =
  | { kind: "range"; min?: number; max?: number; unit: string }
  | { kind: "expected"; value: number | string | boolean | null; unit?: string }
  | { kind: "regex"; pattern: string; flags: "" | "i" | "m" | "im" };
type Judged = { result: "pass" | "fail"; reason?: string };

/** A plan's RE2 pattern, compiled the same way wherever a reply is judged. */
export function limitPattern(limits: { pattern: string; flags: string }) {
  const flags = (limits.flags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0) | (limits.flags.includes("m") ? RE2JS.MULTILINE : 0);
  return RE2JS.compile(limits.pattern, flags);
}

/** Judge one value against a plan's limits. Undefined when there are none. */
export function judgeLimits(limit: Limits | undefined, observed: { value?: unknown; unit?: string }): Judged | undefined {
  if (!limit) return undefined;
  if (limit.kind === "range" || limit.kind === "expected" && limit.unit !== undefined) {
    if (observed.unit !== limit.unit) return { result: "fail", reason: "The measured unit does not match this step's limits." };
  }
  if (limit.kind === "range") {
    const value = observed.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return { result: "fail", reason: "The instrument did not return a finite measurement." };
    return limit.min !== undefined && value < limit.min || limit.max !== undefined && value > limit.max ? { result: "fail", reason: "The measurement is outside its limits." } : { result: "pass" };
  }
  if (limit.kind === "expected") return observed.value === limit.value ? { result: "pass" } : { result: "fail", reason: "The value does not match the expected value." };
  return typeof observed.value === "string" && limitPattern(limit).matcher(observed.value).find() ? { result: "pass" } : { result: "fail", reason: "The reply does not match the expected pattern." };
}

export interface TargetCheckResult extends TargetResultLine { result: "pass" | "fail"; reason?: string }

/** Judge what test firmware printed against the plan: every line it reports
 *  must say PASS, every check the plan requires must be there, and a check
 *  with limits must also be inside them, whatever the firmware said. */
export function judgeTargetRun(action: { done: string; checks: Array<{ name: string; limits?: Limits; required: boolean }> }, text: string): Judged & { done: boolean; checks: TargetCheckResult[] } {
  const { lines, done } = parseTargetResults(text, action.done);
  const checks: TargetCheckResult[] = lines.map(line => {
    if (line.verdict === "FAIL") return { ...line, result: "fail", reason: "The board reported a failure." };
    const planned = action.checks.find(c => c.name === line.name);
    const judged = judgeLimits(planned?.limits, line);
    return judged?.result === "fail" ? { ...line, result: "fail", reason: judged.reason } : { ...line, result: "pass" };
  });
  const failed = checks.find(c => c.result === "fail");
  const missing = action.checks.find(c => c.required && !lines.some(line => line.name === c.name));
  if (!done) return { result: "fail", reason: `The test firmware did not print ${action.done}.`, done, checks };
  if (failed) return { result: "fail", reason: `${failed.name}: ${failed.reason}`, done, checks };
  if (missing) return { result: "fail", reason: `The test firmware did not report ${missing.name}.`, done, checks };
  if (!checks.length) return { result: "fail", reason: "The test firmware reported no results.", done, checks };
  return { result: "pass", done, checks };
}
