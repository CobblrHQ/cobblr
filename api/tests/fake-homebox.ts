// A Homebox v0.26 that answers the way the live instance did during the
// 2026-07-09 proof: /users/self, /entities (summary list), /entities/{id}
// (hydrated), /entities/tree (nested locations) and a photo attachment.
// Shared by the direct connector test and the through-a-bridge one.
import { createServer, type Server } from "node:http";

// A 1×1 PNG (valid image bytes for the attachment endpoint).
export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");

/** Mock Homebox v0.26: /users/self, /entities (summary list), /entities/{id}
 *  (hydrated), /entities/tree (nested locations), /entities/{id}/attachments/{a}. */
export function mockHomebox(): Server {
  const items = [
    {
      id: "I1", name: "DeWalt Drill", parent: { id: "L3" }, entityType: { isLocation: false },
      description: "cordless", quantity: 2, serialNumber: "DWSN-1", modelNumber: "DCD791",
      manufacturer: "DeWalt", notes: "worn", purchasePrice: 159, warrantyExpires: "2026-03-14",
      insured: true, archived: false, lifetimeWarranty: false, assetId: "000-001", purchaseFrom: "Home Depot",
      imageId: "A1", attachments: [{ id: "A1", primary: true, type: "photo" }],
      fields: [{ name: "Voltage", textValue: "20V" }], tags: [{ id: "T1", name: "power-tools" }, { id: "T2", name: "drill" }],
    },
  ];
  const tree = [
    { id: "L1", name: "Workshop", type: "location", children: [
      { id: "L2", name: "Tool Chest", type: "location", children: [
        { id: "L3", name: "Top Drawer", type: "location", children: [
          { id: "I1", name: "DeWalt Drill", type: "item", children: [] }, // items nest in the tree — the type filter drops them
        ] },
      ] },
    ] },
  ];
  return createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (url === "/api/v1/users/self") return void res.end(JSON.stringify({ item: { name: "Demo" } }));
    if (url === "/api/v1/entities/tree") return void res.end(JSON.stringify(tree));
    if (url === "/api/v1/entities") return void res.end(JSON.stringify({ items: items.map((i) => ({ id: i.id, name: i.name, parent: i.parent })), total: 1, page: 1, pageSize: 100 }));
    const detail = (url ?? "").match(/^\/api\/v1\/entities\/([^/]+)$/);
    if (detail) { const it = items.find((i) => i.id === detail[1]); res.statusCode = it ? 200 : 404; return void res.end(JSON.stringify(it ?? {})); }
    if (/^\/api\/v1\/entities\/[^/]+\/attachments\/[^/]+$/.test(url ?? "")) { res.setHeader("content-type", "image/png"); return void res.end(PNG); }
    res.statusCode = 404; res.end("{}");
  });
}

