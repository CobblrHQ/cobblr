/** The actions that move a record's stock: off on a record marked gone
 *  (#6153). The server refuses them there (registerRecordCheck), and the
 *  part's page leaves them out. */
export const STOCK_MOVES: readonly string[] = [
  "inventory:use-one",
  "inventory:use-up",
  "inventory:mark-spoiled",
  "inventory:restock-one",
  "inventory:receive-lot",
  "inventory:receive-package",
  "inventory:split-lot",
  "inventory:consume-with-loss",
  "inventory:consume-stock",
  "inventory:adjust-stock",
];
