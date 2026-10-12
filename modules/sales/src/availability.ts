import { planFulfilment, type FulfilLine } from "./fulfilment.js";
import type { WorkOrderView } from "./work-orders.js";

export interface LineAvailability {
  line_id: string;
  needed: number;
  /** How much of what is still owed the shelf covers: never the stock. */
  in_stock: number;
  /** What the record has on the shelf now, whatever this line takes (#6002). */
  on_hand: number;
  /** The unit both are counted in ("m", "each"), or null. */
  unit: string | null;
  being_made: number;
  short: number;
  make_qty: number;
}

export async function orderAvailability(orgId: string, lines: FulfilLine[], workOrders: WorkOrderView[]): Promise<LineAvailability[]> {
  const { take, onHand } = await planFulfilment(orgId, lines);
  const pending = new Map<string, number>();
  const planned = new Map<string, number>();
  for (const w of workOrders) {
    if (!w.output_part_id || w.status !== "planned") continue;
    pending.set(w.output_part_id, (pending.get(w.output_part_id) ?? 0) + Math.max(0, w.qty - w.made));
    planned.set(w.output_part_id, (planned.get(w.output_part_id) ?? 0) + w.qty);
  }
  return lines.filter((l) => l.part_id).map((l) => {
    const needed = Math.max(0, l.qty - l.qty_fulfilled);
    const in_stock = take.get(l.id) ?? 0;
    const being_made = Math.min(needed - in_stock, pending.get(l.part_id!) ?? 0);
    pending.set(l.part_id!, (pending.get(l.part_id!) ?? 0) - being_made);
    const short = needed - in_stock - being_made;
    // Asking again replaces an open work order's total, so retain what it
    // already promises rather than replacing it with just the extra parts.
    const shelf = onHand.get(l.part_id!);
    return { line_id: l.id, needed, in_stock, on_hand: shelf?.on_hand ?? 0, unit: shelf?.unit ?? null, being_made, short, make_qty: (planned.get(l.part_id!) ?? 0) + short };
  });
}
