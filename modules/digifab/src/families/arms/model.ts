import { z } from "zod";
import { ARM_MAINTENANCE } from "@cobblr/platform-contract/robot-arm";
const Line = (max: number) => z.string().trim().max(max);
export const SetupSchema = z.object({ connection_id: z.string().uuid().nullable().default(null), device_id: z.string().min(1).max(200).nullable().default(null) }).refine(s => !!s.connection_id === !!s.device_id, "Choose both the connection and the arm, or neither.");
const Evidence = z.object({ tested_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), by: Line(200).min(1), setup: Line(500).min(1), notes: Line(4000).default("") }).nullable().default(null);
/** What a unit is known to work with, before anyone calls it supported. */
export const CompatibilitySchema = z.object({
 controller_generation: Line(200).default(""), firmware: Line(200).default(""),
 options: z.array(Line(200).min(1)).max(100).default([]),
 interfaces: z.array(z.object({ name: Line(100).min(1), enabled: z.boolean(), read: z.boolean(), write: z.boolean() })).max(50).default([]),
 simulator_evidence: Evidence, hardware_evidence: Evidence,
});
export type Compatibility = z.infer<typeof CompatibilitySchema>;
export const MaintenanceSchema = z.object({ maintenance: z.enum(ARM_MAINTENANCE), note: Line(1000).default("") });
export const ProgramEditSchema = z.object({ family: Line(200).nullable().transform(f => f || null).optional(), tool: Line(500).optional(), installation: Line(500).optional() }).refine(p => Object.values(p).some(v => v !== undefined), "Change the family, tool or installation.");
export const TypedProgramSchema = z.object({ name: Line(200).min(1), revision: Line(200).nullable().default(null).transform(r => r || null), family: Line(200).nullable().default(null).transform(f => f || null), tool: Line(500).default(""), installation: Line(500).default("") });
export type Support = "untested" | "simulator" | "hardware";
/** A unit is supported on hardware only with hardware evidence; a simulator
 *  run proves protocol handling, not a cell. */
export function supportOf(c: Compatibility): Support {
 return c.hardware_evidence ? "hardware" : c.simulator_evidence ? "simulator" : "untested";
}
