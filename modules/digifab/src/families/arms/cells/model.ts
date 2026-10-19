import { createHash } from "node:crypto";
import { z } from "zod";
import { edgeInstanceOf, isEdgeManagerUrl } from "@cobblr/platform-contract/edge-bridge-client";
import { CellJobSchema, CellRoleSchema, CellStepSchema, CELL_MACHINE_KINDS, type CellJob, type CellMachine } from "@cobblr/platform-contract/robot-cell";

/** One machine of the cell as Cobblr keeps it: an arm or a machine is a
 *  Machines record (an arm's bridge device comes from its arm setup), a
 *  sensor is a device on the bridge. */
export const MemberSchema = z.object({
  role: CellRoleSchema,
  kind: z.enum(CELL_MACHINE_KINDS),
  machine_id: z.string().uuid().nullable().default(null),
  connection_id: z.string().uuid().nullable().default(null),
  device_id: z.string().trim().min(1).max(200).nullable().default(null),
}).strict().superRefine((m, ctx) => {
  if (m.kind !== "sensor" && !m.machine_id) ctx.addIssue({ code: "custom", path: ["machine_id"], message: `Choose the machine that is ${m.role}.` });
  if (m.kind !== "arm" && (!m.connection_id || !m.device_id)) ctx.addIssue({ code: "custom", path: ["device_id"], message: `Choose ${m.role}'s connection and device on the bridge.` });
});
export type Member = z.infer<typeof MemberSchema>;

export const CellSetupSchema = z.object({
  connection_id: z.string().uuid().nullable().default(null),
  device_id: z.string().trim().min(1).max(200).nullable().default(null),
  members: z.array(MemberSchema).max(20).default([]),
}).strict().refine((s) => !!s.connection_id === !!s.device_id, "Choose both the cell's connection and its device, or neither.");

/** A cell's job without its machines: the steps, the cycles and the parts.
 *  The machines come from the cell's members when it starts. */
export const CellDefinitionSchema = z.object({
  label: z.string().trim().max(200).default(""),
  steps: z.array(CellStepSchema).max(50).default([]),
  cycles: z.number().int().positive().max(1_000_000).nullable().default(1),
  parts_per_cycle: z.number().int().nonnegative().max(10_000).default(1),
}).strict();
export type CellDefinition = z.infer<typeof CellDefinitionSchema>;

export const OperatorsSchema = z.object({ operators: z.array(z.string().uuid()).max(50) }).strict();
export const OutputSchema = z.object({ output_part_id: z.string().uuid().nullable() }).strict();

/** The job the bridge runs: the definition over the members it names. */
export function cellJob(definition: CellDefinition, members: CellMachine[]): CellJob {
  return CellJobSchema.parse({ ...definition, machines: members });
}

/** What a person checks at the cell before a start: the job and each arm's
 *  installed tooling. Any change to either is a different hash, so a start
 *  approved on one screen cannot run something else. */
export function definitionHash(job: CellJob, tooling: Record<string, string>): string {
  const canonical = JSON.stringify({ job, tooling: Object.keys(tooling).sort().map((k) => [k, tooling[k]]) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Which bridge and instance a connection reaches: its tunnel channel or its
 *  address, and the instance id the bridge serves it at. */
export function bridgeAddressOf(baseUrl: string, edgeBridge: string | null): { bridge: string; instance: string | null } {
  if (isEdgeManagerUrl(baseUrl)) return { bridge: `tunnel:${edgeBridge ?? ""}`, instance: edgeInstanceOf(baseUrl) };
  try {
    const url = new URL(baseUrl);
    return { bridge: `direct:${url.origin}`, instance: url.pathname.split("/").filter(Boolean)[0] ?? null };
  } catch { return { bridge: `unknown:${baseUrl}`, instance: null }; }
}
