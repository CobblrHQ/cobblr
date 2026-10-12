// What a build can use or make: stock in every collection this workspace
// keeps it in, through the one search the platform owns (#5892).
import type { EntityViewer } from "@cobblr/platform-contract";
import { searchStock, stockNamed, type StockOption } from "@cobblr/platform-contract/stock-search";

/** The stock door a build moves counts through, on its components and on
 *  what it makes. Only a kind whose count moves this way is stock to a build. */
export const STOCK_ACTION = "inventory:adjust-stock";

export function searchComponents(orgId: string, q: string, viewer?: EntityViewer): Promise<StockOption[]> {
  return searchStock(orgId, q, viewer, { adjustAction: STOCK_ACTION });
}

export function componentsNamed(orgId: string, name: string, viewer?: EntityViewer): Promise<StockOption[]> {
  return stockNamed(orgId, name, viewer, { adjustAction: STOCK_ACTION });
}
