// The cell contract, shared by Cobblr and the edge bridge (which mirrors this
// file at a pinned core commit beside robot-arm.ts). A cell is machines that
// work together, a CNC and the arm that unloads it, and a cell job is one job
// at the edge: Cobblr hands the bridge the whole job, the bridge runs its steps
// in order against the machines it fronts, and Cobblr watches and records what
// each step did. Cobblr never dispatches a step, never retries motion and is
// never an interlock; the controllers and the cell's safety devices are.
//
// On any failure the bridge pauses everything it can and stops the job where
// it is: a person decides what happens next, at the cell.

import { z } from "zod";
import { ArmProgramRefSchema } from "@cobblr/platform-contract/robot-arm";

const Text = (max: number) => z.string().trim().min(1).max(max);
/** A machine's part in the cell, named by the person setting it up ("cnc",
 *  "arm", "door-sensor"). */
export const CellRoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "A role is lowercase letters, digits and dashes, like cnc or unload-arm.");

export const CELL_MACHINE_KINDS = ["arm", "machine", "sensor"] as const;
/** One machine of the cell: which bridge instance fronts it (the last part of
 *  its connection's address) and which of that instance's devices it is. */
export const CellMachineSchema = z.object({
  role: CellRoleSchema,
  kind: z.enum(CELL_MACHINE_KINDS),
  instance: z.string().regex(/^[\w.-]{1,100}$/, "Name the bridge instance that fronts the machine."),
  device_id: Text(200),
}).strict();
export type CellMachine = z.infer<typeof CellMachineSchema>;

const Timeout = z.number().int().min(1).max(24 * 3600);
/** One step of a cell job. Each waits for its own end and fails on its
 *  timeout; none is a safety function. */
export const CellStepSchema = z.discriminatedUnion("kind", [
  /** Start a program file already on a machine (the next CNC job) and wait
   *  for the machine to report it done. */
  z.object({ kind: z.literal("machine-job"), role: CellRoleSchema, file: Text(300), timeout_s: Timeout }).strict(),
  /** Load and start an arm's program and wait for its run to end completed,
   *  on the arm's own evidence. */
  z.object({ kind: z.literal("arm-program"), role: CellRoleSchema, program: ArmProgramRefSchema, timeout_s: Timeout }).strict(),
  /** Wait for a machine to be idle: not working and not in error. */
  z.object({ kind: z.literal("wait-machine"), role: CellRoleSchema, timeout_s: Timeout }).strict(),
  /** Wait for a sensor's reading to be within bounds (a part-present switch
   *  reads 1, a door reads closed). */
  z.object({ kind: z.literal("wait-input"), role: CellRoleSchema, min: z.number().finite().nullable().default(null), max: z.number().finite().nullable().default(null), timeout_s: Timeout }).strict(),
]);
export type CellStep = z.infer<typeof CellStepSchema>;
export type CellStepKind = CellStep["kind"];

const STEP_MACHINE_KIND: Record<CellStepKind, (typeof CELL_MACHINE_KINDS)[number]> = { "machine-job": "machine", "arm-program": "arm", "wait-machine": "machine", "wait-input": "sensor" };

/** A cell job: its machines, its steps in order, how many cycles (null runs
 *  until stopped) and how many parts one cycle makes. */
export const CellJobSchema = z.object({
  label: z.string().trim().max(200).default(""),
  machines: z.array(CellMachineSchema).min(1).max(20),
  steps: z.array(CellStepSchema).min(1).max(50),
  cycles: z.number().int().positive().max(1_000_000).nullable().default(1),
  parts_per_cycle: z.number().int().nonnegative().max(10_000).default(1),
}).strict().superRefine((job, ctx) => {
  const roles = new Map<string, string>();
  job.machines.forEach((m, i) => {
    if (roles.has(m.role)) ctx.addIssue({ code: "custom", path: ["machines", i, "role"], message: `Two machines are both "${m.role}".` });
    roles.set(m.role, m.kind);
  });
  job.steps.forEach((s, i) => {
    if (s.kind === "wait-input" && s.min === null && s.max === null) ctx.addIssue({ code: "custom", path: ["steps", i], message: `Step ${i + 1}: give the reading's lowest or highest value, or both.` });
    if (s.kind === "wait-input" && s.min !== null && s.max !== null && s.min > s.max) ctx.addIssue({ code: "custom", path: ["steps", i], message: `Step ${i + 1}: the lowest value is above the highest.` });
    const kind = roles.get(s.role);
    if (!kind) ctx.addIssue({ code: "custom", path: ["steps", i, "role"], message: `Step ${i + 1} uses "${s.role}", which is not one of the cell's machines.` });
    else if (kind !== STEP_MACHINE_KIND[s.kind]) ctx.addIssue({ code: "custom", path: ["steps", i, "role"], message: `Step ${i + 1} (${s.kind}) needs ${STEP_MACHINE_KIND[s.kind] === "arm" ? "an arm" : `a ${STEP_MACHINE_KIND[s.kind]}`}; "${s.role}" is ${kind === "arm" ? "an arm" : `a ${kind}`}.` });
  });
});
export type CellJob = z.infer<typeof CellJobSchema>;

export const CellCommandSchema = z.discriminatedUnion("operation", [
  /** Start a job. Cobblr names it, so a lost answer is reconciled by reading
   *  the cell's state for that id, never by starting again. */
  z.object({ operation: z.literal("start"), job_id: z.string().uuid(), job: CellJobSchema }).strict(),
  /** Resume a job paused on a timeout. A job paused on a fault does not
   *  resume: it is stopped, cleared at the machines, and started again. */
  z.object({ operation: z.literal("resume") }).strict(),
  /** Stop the job and every machine it holds, whatever the cell reports. */
  z.object({ operation: z.literal("stop") }).strict(),
]);
export type CellCommand = z.infer<typeof CellCommandSchema>;

export const CELL_STATUS = ["idle", "running", "paused", "ended"] as const;
export const CellStateSchema = z.object({
  connectivity: z.enum(["online", "offline"]),
  status: z.enum(CELL_STATUS),
  job_id: z.string().uuid().nullable(),
  cycle: z.number().int().nonnegative(),
  step: z.number().int().nonnegative().nullable(),
  cycles_done: z.number().int().nonnegative(),
  /** Why the job is paused: what failed, in the machine's words. */
  paused_reason: z.string().max(500).nullable(),
  /** "timeout" resumes; "fault" only stops. */
  paused_on: z.enum(["timeout", "fault"]).nullable(),
  observed_at: z.string().datetime({ offset: true }),
});
export type CellState = z.infer<typeof CellStateSchema>;

export const CellCommandResultSchema = z.object({ ok: z.boolean(), detail: z.string().max(1000).optional(), state: CellStateSchema.optional() });
export type CellCommandResult = z.infer<typeof CellCommandResultSchema>;

/** Whether a command may go to a cell in this state. Stop always goes. */
export function cellCommandRefusal(command: CellCommand, state: CellState | null): string | null {
  if (command.operation === "stop") return null;
  if (!state || state.connectivity !== "online") return "The cell's bridge is not answering. Check it at the cell.";
  if (command.operation === "start" && (state.status === "running" || state.status === "paused")) return "The cell already has a job. Stop it before starting another.";
  if (command.operation === "resume") {
    if (state.status !== "paused") return "Only a paused cell job resumes.";
    if (state.paused_on === "fault") return "The job paused on a fault. Clear it at the machines, stop this job and start again.";
  }
  return null;
}

/** What the cell reports happened, numbered and named once like an arm's
 *  events (robot-arm.ts): a replay records nothing twice and is never a
 *  reason to command anything. */
const EventBase = { id: z.string().min(1).max(200), seq: z.number().int().nonnegative(), at: z.string().datetime({ offset: true }), job_id: z.string().uuid() };
export const CellEventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventBase, type: z.literal("job-started") }),
  z.object({ ...EventBase, type: z.literal("step-started"), cycle: z.number().int().positive(), step: z.number().int().nonnegative(), kind: z.enum(["machine-job", "arm-program", "wait-machine", "wait-input"]), role: CellRoleSchema }),
  z.object({ ...EventBase, type: z.literal("step-ended"), cycle: z.number().int().positive(), step: z.number().int().nonnegative(), outcome: z.enum(["done", "failed"]), detail: z.string().max(500).nullable().default(null), duration_ms: z.number().int().nonnegative() }),
  z.object({ ...EventBase, type: z.literal("cycle-completed"), cycle: z.number().int().positive(), cycle_time_ms: z.number().int().nonnegative(), parts: z.number().int().nonnegative() }),
  z.object({ ...EventBase, type: z.literal("job-paused"), cycle: z.number().int().positive(), step: z.number().int().nonnegative(), on: z.enum(["timeout", "fault"]), reason: z.string().max(500), paused: z.array(CellRoleSchema).max(20), not_paused: z.array(CellRoleSchema).max(20) }),
  z.object({ ...EventBase, type: z.literal("job-resumed") }),
  z.object({ ...EventBase, type: z.literal("job-ended"), outcome: z.enum(["completed", "aborted"]), detail: z.string().max(500).nullable().default(null) }),
]);
export type CellEvent = z.infer<typeof CellEventSchema>;
export const CellEventPageSchema = z.object({ events: z.array(CellEventSchema).max(1000), cursor: z.number().int().nonnegative() });
export type CellEventPage = z.infer<typeof CellEventPageSchema>;
