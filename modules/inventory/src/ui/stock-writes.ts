// Every stock write in inventory's screens goes through here, and refreshes
// every read of the stock it changed.
//
// Each screen used to refresh what its author remembered: the − stepper the
// list and the detail, Stock arrived its own row. Workshop stock reads its
// remaining by another key (["stock-shape", slug, id]) and kept the old
// number until a reload, once for Use some (#5811) and again for Stock
// arrived (#5895). So a stock write refreshes every query that names one of
// the records it touched, every Workshop stock view on screen (a record's
// panel moves when stock arrives at another of its places), and the
// inventory list and detail. lint:capabilities (inventory:stock-writes-refresh)
// holds every write to this door.

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refreshAfterStockChange } from "@cobblr/platform-web";
import { useInventory } from "./context";
import type { InventoryApi } from "./api";

/** The client's stock writes, each with the records it touches. */
export const STOCK_WRITES = {
  receiveLot: (id: string) => [id],
  transferStock: (fromId: string, body: { to_id?: string }) => [fromId, ...(body?.to_id ? [body.to_id] : [])],
  stockAdjust: (id: string) => [id],
  stockAdjustIn: (_instance: string, id: string) => [id],
  consumeStock: (id: string) => [id],
  configureStock: (id: string) => [id],
  loadStock: (id: string) => [id],
  measureMaterial: (id: string) => [id],
  mintUnit: (id: string) => [id],
  // An allocation's id is not the record's: every stock view refreshes.
  setAllocationStatus: () => [] as string[],
} satisfies { [K in keyof InventoryApi]?: (...args: never[]) => string[] };

export type StockWriter = Pick<InventoryApi, keyof typeof STOCK_WRITES>;

/** The stock writes, each refreshing what it changed once it answers (and
 *  when it fails, since a write can land halfway). */
export function useStockWrites(): StockWriter {
  const { api } = useInventory();
  const qc = useQueryClient();
  return useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [name, idsOf] of Object.entries(STOCK_WRITES)) {
      out[name] = async (...args: unknown[]) => {
        try {
          return await (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args);
        } finally {
          void refreshAfterStockChange(qc, (idsOf as (...a: unknown[]) => string[])(...args));
        }
      };
    }
    return out as unknown as StockWriter;
  }, [api, qc]);
}
