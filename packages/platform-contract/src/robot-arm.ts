// The robot-arm driver contract, shared by Cobblr and the edge bridge (which
// mirrors this file at a pinned core commit). An arm is coordinated, never
// controlled: Cobblr asks the arm's manager on the bridge to load, start,
// pause, resume or stop a program the controller already holds, and reads
// what it reports. Motion, interlocks and safety stay in the controller.
//
// The operations that would make Cobblr part of a safety chain are named in
// ARM_FORBIDDEN_OPERATIONS and are not in the command schema at all, so no
// caller can send one and no bridge can be asked for one.

import { z } from "zod";

export const ARM_CONNECTIVITY = ["online", "offline", "unknown"] as const;
export const ARM_MODES = ["remote", "local", "unknown"] as const;
export const ARM_EXECUTION = ["idle", "loaded", "running", "paused", "stopped", "unknown"] as const;
export const ARM_SAFETY = ["normal", "protective-stop", "emergency-stop", "fault", "unknown"] as const;
export const ARM_POWER = ["on", "off", "unknown"] as const;
export const ARM_MAINTENANCE = ["in-service", "down-for-repair"] as const;

const Text = (max: number) => z.string().trim().min(1).max(max);

export const ArmProgramRefSchema = z.object({ name: Text(200), revision: z.string().trim().max(200).nullable() });
export type ArmProgramRef = z.infer<typeof ArmProgramRefSchema>;

/** What the controller reports, one dimension at a time: each changes on its
 *  own, so none of them is folded into another (a paused program on an arm in
 *  protective stop is both). */
export const ArmStateSchema = z.object({
  connectivity: z.enum(ARM_CONNECTIVITY),
  mode: z.enum(ARM_MODES),
  execution: z.enum(ARM_EXECUTION),
  safety: z.enum(ARM_SAFETY),
  power: z.enum(ARM_POWER).default("unknown"),
  safety_detail: z.string().max(500).nullable().default(null),
  program: ArmProgramRefSchema.nullable().default(null),
  /** The controller's own identity for the run it is executing, when it has
   *  one: how an uncertain start is reconciled by reading, never by resending. */
  run_id: z.string().max(200).nullable().default(null),
  observed_at: z.string().datetime({ offset: true }),
});
export type ArmState = z.infer<typeof ArmStateSchema>;

export const ArmInfoSchema = z.object({
  model: Text(200),
  serial: z.string().trim().max(200).nullable(),
  controller_generation: z.string().trim().max(200).nullable(),
  software_versions: z.array(z.object({ name: Text(100), version: Text(100) })).max(50),
  options: z.array(Text(200)).max(100),
  interfaces: z.array(z.object({ name: Text(100), enabled: z.boolean() })).max(50),
});
export type ArmInfo = z.infer<typeof ArmInfoSchema>;

/** One program the controller holds. `revision` is the checksum or version the
 *  controller reports, or null when it reports none. */
export const ArmControllerProgramSchema = ArmProgramRefSchema.extend({ modified: z.string().datetime({ offset: true }).nullable().default(null) });
export type ArmControllerProgram = z.infer<typeof ArmControllerProgramSchema>;

/** `supported: false` is a controller that cannot list its programs: they are
 *  typed in Cobblr instead, never guessed. */
export const ArmProgramListSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(true), programs: z.array(ArmControllerProgramSchema).max(2000) }),
  z.object({ supported: z.literal(false), detail: z.string().max(500) }),
]);
export type ArmProgramList = z.infer<typeof ArmProgramListSchema>;

export const ARM_OPERATIONS = ["load", "start", "pause", "resume", "stop", "power"] as const;
export type ArmOperation = (typeof ARM_OPERATIONS)[number];

/** Never in the contract. Listed so the docs, the lint and the tests can name
 *  what is refused, and so a bridge refuses them by name. */
export const ARM_FORBIDDEN_OPERATIONS = [
  "clear-protective-stop",
  "clear-emergency-stop",
  "unlock-safety",
  "set-safety-configuration",
  "move",
  "jog",
  "free-drive",
  "brake-release",
] as const;

export const ArmCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("load"), program: ArmProgramRefSchema }).strict(),
  // Start names the program it expects to be loaded, so the bridge refuses a
  // start when the controller holds anything else.
  z.object({ operation: z.literal("start"), program: ArmProgramRefSchema }).strict(),
  z.object({ operation: z.literal("pause") }).strict(),
  z.object({ operation: z.literal("resume") }).strict(),
  z.object({ operation: z.literal("stop") }).strict(),
  z.object({ operation: z.literal("power"), state: z.enum(["on", "off"]) }).strict(),
]);
export type ArmCommand = z.infer<typeof ArmCommandSchema>;

export const ArmCommandResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string().max(1000).optional(),
  state: ArmStateSchema.optional(),
  /** A start's run identity, from the controller or the bridge. */
  run_id: z.string().max(200).optional(),
});
export type ArmCommandResult = z.infer<typeof ArmCommandResultSchema>;

/** Whether a command may be sent to an arm in this state. Pause and stop are
 *  always sent: refusing a stop because of a reading would be worse than the
 *  controller ignoring it. Everything that makes the arm do more needs the
 *  controller online, in remote mode and with its safety normal; the pendant
 *  (local mode) always wins. Returns the reason it may not, or null. */
export function armCommandRefusal(command: ArmCommand, state: ArmState | null): string | null {
  if (command.operation === "pause" || command.operation === "stop") return null;
  if (command.operation === "power" && command.state === "off") return null;
  if (!state || state.connectivity !== "online") return "The arm's controller is not answering. Check it at the cell.";
  if (state.mode !== "remote") return "The arm is in local mode: the pendant has control. Switch it to remote mode at the pendant.";
  if (state.safety !== "normal") return `The arm reports ${state.safety.replace(/-/g, " ")}. Clear it at the pendant after checking the cell; Cobblr never clears a stop.`;
  if (command.operation === "start") {
    if (state.execution !== "loaded" && state.execution !== "stopped" && state.execution !== "idle") return `The arm is ${state.execution}. Start needs a loaded program that is not running.`;
    if (!state.program || state.program.name !== command.program.name || state.program.revision !== command.program.revision) return "The controller holds a different program or revision. Load this one first.";
  }
  if (command.operation === "load" && (state.execution === "running" || state.execution === "paused")) return "Stop the running program before loading another.";
  if (command.operation === "resume" && state.execution !== "paused") return "Only a paused program resumes.";
  return null;
}

/** What the arm reports happened, in order. The bridge numbers them (`seq`,
 *  increasing) and names each once (`id`), and keeps them while Cobblr cannot
 *  reach it, so a replay after an outage is the same events again: Cobblr
 *  records each id once, and an event only ever changes records. It is never
 *  a reason to command the arm. */
const EventBase = { id: z.string().min(1).max(200), seq: z.number().int().nonnegative(), at: z.string().datetime({ offset: true }) };
export const ArmEventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventBase, type: z.literal("run-started"), run_id: z.string().min(1).max(200), program: ArmProgramRefSchema }),
  z.object({ ...EventBase, type: z.literal("cycle-completed"), run_id: z.string().min(1).max(200), cycle: z.number().int().positive(), good: z.number().int().nonnegative().default(0), scrap: z.number().int().nonnegative().default(0) }),
  z.object({ ...EventBase, type: z.literal("run-ended"), run_id: z.string().min(1).max(200), outcome: z.enum(["completed", "aborted"]), detail: z.string().max(500).nullable().default(null) }),
  z.object({ ...EventBase, type: z.literal("safety-changed"), safety: z.enum(ARM_SAFETY), detail: z.string().max(500).nullable().default(null) }),
  z.object({ ...EventBase, type: z.literal("mode-changed"), mode: z.enum(ARM_MODES) }),
]);
export type ArmEvent = z.infer<typeof ArmEventSchema>;
/** The events after a cursor (`seq`), and the cursor to ask from next. */
export const ArmEventPageSchema = z.object({ events: z.array(ArmEventSchema).max(1000), cursor: z.number().int().nonnegative() });
export type ArmEventPage = z.infer<typeof ArmEventPageSchema>;

/** A run is the unit of work Cobblr approves, watches and records: one
 *  invocation of a program, a batch of cycles, an order, a shift, or a
 *  continuous program (palletising until full). It has cycles and parts. */
export const ARM_RUN_KINDS = ["invocation", "batch", "order", "shift", "continuous"] as const;
export type ArmRunKind = (typeof ARM_RUN_KINDS)[number];
/** How a run ended. `stopped` or `idle` on the controller is none of these:
 *  completed and aborted need the controller's run-ended event for this run;
 *  unknown and not-started are said explicitly. */
export const ARM_RUN_OUTCOMES = ["completed", "aborted", "unknown", "not-started"] as const;
export type ArmRunOutcome = (typeof ARM_RUN_OUTCOMES)[number];
