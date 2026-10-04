import { ActionRefusal } from "@cobblr/platform-contract";

export function weightFromLength(mm: number, density: number | null, diameter: number | null): number {
  if (!Number.isFinite(mm) || mm < 0 || !density || !diameter || !Number.isFinite(density) || !Number.isFinite(diameter) || density <= 0 || diameter <= 0) {
    throw new ActionRefusal("Set the filament density and diameter before using a length.");
  }
  return mm * Math.PI * (diameter / 2) ** 2 * density / 1000;
}

export function weightFromScale(gross: number, tare: number | null): number {
  if (tare == null || !Number.isFinite(tare) || tare < 0) throw new ActionRefusal("Set the empty spool weight before weighing it.");
  if (!Number.isFinite(gross) || gross < tare) throw new ActionRefusal("The scale reading must be at least the empty spool weight.");
  return gross - tare;
}

export interface MaterialNumbers {
  remaining_g: number;
  initial_g: number;
  used_g: number;
  remaining_m: number | null;
  used_m: number | null;
  first_used: string | null;
  last_used: string | null;
}

export function materialNumbers(
  remaining: number,
  initial: number | null,
  density: number | null,
  diameter: number | null,
  ledger: readonly { delta: number; kind: string | null; at: string }[],
): MaterialNumbers {
  const uses = ledger.filter((r) => r.kind !== "correction" && r.delta < 0);
  const used = Math.max(0, -ledger.filter((r) => r.kind !== "correction").reduce((sum, r) => sum + r.delta, 0));
  const dates = uses.map((r) => r.at).sort();
  let gramsPerMetre: number | null = null;
  try { gramsPerMetre = weightFromLength(1000, density, diameter); } catch { /* Missing physical measurements leave length unknown. */ }
  return {
    remaining_g: remaining,
    initial_g: initial ?? remaining + used,
    used_g: used,
    remaining_m: gramsPerMetre ? remaining / gramsPerMetre : null,
    used_m: gramsPerMetre ? used / gramsPerMetre : null,
    first_used: dates[0] ?? null,
    last_used: dates.at(-1) ?? null,
  };
}
