import { amountOf, centsFromAmount } from "@cobblr/platform-contract/money";
import type { EntityRef, PlacePathStep, PlacementWorth } from "@cobblr/platform-contract";

export function sumPlaceWorth(
  rows: Array<EntityRef & { value: number | null }>,
  paths: Map<string, PlacePathStep[]>,
  within?: EntityRef | null,
): PlacementWorth {
  const unique = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
  const items = [...unique.values()].filter((r) => (r.value === null || Number.isFinite(r.value)) && (!within || (paths.get(`${r.kind}:${r.id}`) ?? []).some((s) => s.kind === within.kind && s.id === within.id)));
  return { total: amountOf(centsFromAmount(items.reduce((sum, r) => sum + (r.value ?? 0), 0))), records: items.length, unpriced: items.filter((r) => r.value == null).length, items, withheld: false };
}
