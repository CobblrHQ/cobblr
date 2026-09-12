// The three piles of a File everything plan, and what confirm sends back.
//
// The sheet shows "Added to what you have", "Filed as new" and "Left for
// you", then confirms exactly the first two. The route acts only on the ids it
// is sent and only where the plan still holds, so what is sent is what was
// seen: the ids of the two filing piles and each line's action and target.
import type { AutofilePlanLine } from "./api";

export interface Piles {
  attach: Extract<AutofilePlanLine, { action: "attach" }>[];
  create: Extract<AutofilePlanLine, { action: "create" }>[];
  skip: Extract<AutofilePlanLine, { action: "skip" }>[];
}

export function pilesFrom(plans: readonly AutofilePlanLine[]): Piles {
  const out: Piles = { attach: [], create: [], skip: [] };
  for (const p of plans) {
    if (p.action === "attach") out.attach.push(p);
    else if (p.action === "create") out.create.push(p);
    else out.skip.push(p);
  }
  return out;
}

/** What confirm is told: the items the sheet is filing, each with the plan
 *  it showed. The "left for you" pile is not sent: nothing happens to it. */
export function seenFrom(piles: Piles): {
  item_ids: string[];
  seen: Array<{ item_id: string; action: "attach" | "create"; to_id?: string | null; destination?: string | null }>;
} {
  const seen = [
    ...piles.attach.map((p) => ({ item_id: p.itemId, action: "attach" as const, to_id: p.to.id })),
    ...piles.create.map((p) => ({ item_id: p.itemId, action: "create" as const, destination: p.destination ?? null })),
  ];
  return { item_ids: seen.map((x) => x.item_id), seen };
}

/** "+2 to Cucumbers · same barcode": the line a person reads. */
export function lineFor(p: AutofilePlanLine): { name: string; detail: string } {
  const name = p.name ?? "(unnamed)";
  if (p.action === "attach") return { name, detail: `+${p.qty} to ${p.to.title} · ${p.why}` };
  if (p.action === "create") {
    const where = p.destination ? `into ${p.destination}${p.installs ? " (installs it first)" : ""}` : "as new";
    return { name, detail: `${p.qty > 1 ? `×${p.qty} ` : ""}${where} · ${p.why}` };
  }
  return { name, detail: p.why };
}
