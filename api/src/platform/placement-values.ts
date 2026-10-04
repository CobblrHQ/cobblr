import type { DatedMoney } from "@cobblr/platform-contract";

export type PlaceValueReader = (orgId: string, ids: string[] | "all") => Promise<Map<string, number | null | DatedMoney>>;

export async function readEnabledPlaceValues(
  orgId: string,
  kind: string,
  ids: string[] | "all",
  reader: PlaceValueReader,
  moduleEnabled: (orgId: string, moduleName: string) => Promise<boolean>,
): Promise<Map<string, number | null | DatedMoney>> {
  if (!await moduleEnabled(orgId, kind.split(":")[0]!)) return new Map();
  return reader(orgId, ids);
}
