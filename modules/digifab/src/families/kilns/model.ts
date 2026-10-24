import "./db.js";
import { z } from "zod";
export const SegmentSchema = z.object({ ramp_c_per_hour: z.number().int().min(1).max(999999), target_c: z.number().int().min(0).max(1500), hold_minutes: z.number().int().min(0).max(1440) });
export const ScheduleSchema = z.array(SegmentSchema).min(1).max(32);
export const PieceSchema = z.object({ kind: z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/), id: z.string().uuid(), title: z.string().max(200).optional() });
export const ComponentSchema = z.object({ name: z.string().trim().min(1).max(100), interval_hours: z.number().positive().max(100000), replaced_at_hours: z.number().nonnegative().max(1000000) });
export const ProfileSchema = z.object({ connection_id: z.string().uuid().nullable().default(null), device_id: z.string().min(1).max(200).nullable().default(null), components: z.array(ComponentSchema).max(20).default([]), schedules: z.array(z.object({ name: z.string().trim().min(1).max(100), segments: ScheduleSchema })).max(50).default([]) }).refine(p => !!p.connection_id === !!p.device_id, "Choose both the connection and device, or neither.");
export const FiringSchema = z.object({
 name: z.string().trim().min(1).max(200), schedule: ScheduleSchema, cone: z.string().trim().max(20).default(""), notes: z.string().max(10000).default(""),
 pieces: z.array(PieceSchema).max(500).default([]),
 glazes: z.array(z.object({ part_id: z.string().uuid(), kind: z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/).optional(), ml: z.number().positive().max(1000000) })).max(100).default([]),
}).superRefine((f, ctx) => {
 if (new Set(f.pieces.map(p => `${p.kind}:${p.id}`)).size !== f.pieces.length) ctx.addIssue({ code: "custom", message: "Each piece belongs in the load once." });
 if (new Set(f.glazes.map(g => g.part_id)).size !== f.glazes.length) ctx.addIssue({ code: "custom", message: "Record each glaze's total use once." });
});
export type Firing = z.infer<typeof FiringSchema>;
export type Component = z.infer<typeof ComponentSchema>;
export const FinishSchema = z.object({ duration_hours: z.number().positive().max(1000), peak_c: z.number().min(0).max(1500), outcome: z.enum(["completed", "failed", "stopped"]) });
export type Finish = z.infer<typeof FinishSchema>;
export const TelemetrySchema = z.object({ temperature_c: z.number().finite(), segment: z.number().int().nonnegative().nullable(), segments: z.number().int().nonnegative(), elapsed_sec: z.number().nonnegative(), remaining_sec: z.number().nonnegative().nullable(), progress: z.number().min(0).max(1).nullable(), schedule_name: z.string(), running: z.boolean(), errors: z.array(z.string()).nullable() });
export function firingLinks(orgId: string, firingId: string, pieces: Firing["pieces"]) {
 return pieces.map(p => ({ orgId, sourceKind: "digifab:firing", sourceId: firingId, targetKind: p.kind, targetId: p.id, relationshipKind: "contains" }));
}
export function replacementReminders(hours: number, components: Component[]) {
 return components.filter(c => hours - c.replaced_at_hours >= c.interval_hours).map(c => ({ name: c.name, hours_used: hours - c.replaced_at_hours, interval_hours: c.interval_hours }));
}
