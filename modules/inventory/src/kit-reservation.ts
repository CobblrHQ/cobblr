import { createHash } from "node:crypto";
export interface KitLine { part_id: string; qty: number }
export function groupKitLines(lines: readonly KitLine[]): KitLine[] {
  const grouped = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1) throw new Error("Reserve whole, positive counts for a kit.");
    const qty = (grouped.get(line.part_id) ?? 0) + line.qty;
    if (!Number.isSafeInteger(qty)) throw new Error("This kit count is too large.");
    grouped.set(line.part_id, qty);
  }
  if (!grouped.size) throw new Error("Choose stock for the kit.");
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([part_id, qty]) => ({ part_id, qty }));
}
export function kitFingerprint(lines: readonly KitLine[]) {
  return createHash("sha256").update(JSON.stringify(groupKitLines(lines))).digest("hex");
}
export function checkKitReservation(lines: readonly KitLine[], stock: readonly { id: string; qty: number; reserved: number; usable: boolean; reason?: string | null }[]) {
  for (const line of groupKitLines(lines)) {
    const part = stock.find(p => p.id === line.part_id);
    if (!part) throw new Error("A kit item is missing or unavailable.");
    if (!part.usable) throw new Error(part.reason ?? "Check this item's storage before release.");
    if (!Number.isSafeInteger(part.qty) || !Number.isFinite(part.reserved) || part.reserved < 0 || part.qty - part.reserved < line.qty) throw new Error("There is not enough free stock for this kit. Check the count and other reservations.");
  }
}
export function checkKitOutput(blanks: number, output: { qty: number; unit: string; available: boolean }) {
  if (!output.available) throw new Error("Choose an available placed-board stock record.");
  if (output.unit !== "each") throw new Error("Placed boards must be count stock measured in each.");
  if (!Number.isSafeInteger(blanks) || blanks < 1 || output.qty !== blanks) throw new Error("Placed boards must match the blank boards reserved in this kit.");
}
