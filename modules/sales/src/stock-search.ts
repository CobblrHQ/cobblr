// What a sales line can be sold from: every record a fulfilment can draw, in
// every collection this workspace keeps stock in (#5825), through the one
// search the platform owns (@cobblr/platform-contract/stock-search).
import type { EntityViewer } from "@cobblr/platform-contract";
import { searchStock as searchEveryCollection, type StockOption } from "@cobblr/platform-contract/stock-search";
import { DRAW_ACTION } from "./fulfilment.js";

export type { StockOption };

/** Search every stocked kind for `q`, best matches first. */
export function searchStock(orgId: string, q: string, viewer: EntityViewer, limit = 20): Promise<StockOption[]> {
  return searchEveryCollection(orgId, q, viewer, { adjustAction: DRAW_ACTION, limit });
}
