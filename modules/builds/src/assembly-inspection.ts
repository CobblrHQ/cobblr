export interface InspectionDecision { ordinal: number; status: "pass" | "fail"; front_file_id: string; back_file_id: string; defects: string[]; notes: string; serial_code?: string | null }
interface TraceSource {
 released_by?: string | null;
 kit_plan?: Array<{ part_id: string; kind: string; qty: number; placements: number; role: string; lot_code?: string | null }>;
 paste?: { part_id: string; kind: string; lot_code: string; stencil_id: string; amount_ml: number; applied_at: string; source: string };
 placement?: { sides: Partial<Record<string, { operator_id: string | null }>> };
 reflow?: { run_id: string; profile_id: string; profile_hash: string; operator_id?: string | null; report?: { in_spec: boolean } };
}
export function assemblyTrace(order: TraceSource) {
 if (!order.paste || !order.reflow || !order.kit_plan?.some(line => line.role === "component")) throw new Error("This batch needs its captured reels, paste and completed reflow run before trace can be finished.");
 return structuredClone({ reels: order.kit_plan.filter(line => line.role === "component"), blanks: order.kit_plan.filter(line => line.role === "blank"), paste: order.paste, stencil_id: order.paste.stencil_id, reflow: { run_id: order.reflow.run_id, profile_id: order.reflow.profile_id, profile_hash: order.reflow.profile_hash, report: order.reflow.report }, operators: [...new Set([order.released_by, ...Object.values(order.placement?.sides ?? {}).map(side => side?.operator_id), order.reflow.operator_id].filter((id): id is string => !!id))] });
}
export function checkInspection(decision: InspectionDecision, quantity: number, flagged: boolean) {
 if (!Number.isInteger(decision.ordinal) || decision.ordinal < 1 || decision.ordinal > quantity) throw new Error("Choose a board number in this work order.");
 if (!decision.front_file_id || !decision.back_file_id || decision.front_file_id === decision.back_file_id) throw new Error("Keep distinct front and back photos of this board.");
 if (decision.status === "fail" && !decision.defects.length) throw new Error("Tag at least one defect on a failed board.");
 if (decision.status === "pass" && decision.defects.length) throw new Error("Resolve the defect tags and record rework before passing this board.");
 if (decision.status === "pass" && flagged && decision.notes.trim().length < 10) throw new Error("Record the inspection review of this flagged reflow run before passing a board.");
 return decision;
}
export function inspectionSummary(rows: Array<{ ordinal: number; status: string; serial_code?: string | null }>, quantity: number) {
 if (rows.length !== quantity || new Set(rows.map(row => row.ordinal)).size !== quantity || rows.some(row => !Number.isInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > quantity || !["pass", "fail"].includes(row.status))) throw new Error("Inspect every board before finishing the batch.");
 const serials = rows.map(row => row.serial_code).filter((value): value is string => !!value);
 if (new Set(serials).size !== serials.length) throw new Error("Every entered board serial must be distinct.");
 return { accepted: rows.filter(row => row.status === "pass").length, rejected: rows.filter(row => row.status === "fail").length };
}
