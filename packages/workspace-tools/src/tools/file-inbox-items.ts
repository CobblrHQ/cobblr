import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool, listTarget } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "file_inbox_items",
  description:
    "File scan inbox items into ONE list (\"file these in Mugs\"), maybe one a create-instance call earlier in the plan makes. Undo returns them.",
  mode: "write",
  params: {
    ids: z.array(z.string()).min(1).max(200),
    list: z.string().describe("e.g. Mugs"),
    catalog_candidates: z.record(z.string()).optional(),
  },
  execute: async (api, args) => {
    const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String).filter(Boolean) : [];
    const said = String(args.list ?? "").trim();
    if (!ids.length || !said) return toolFail("ids and list are required");
    const target = await listTarget(api, said);
    if ("error" in target) return toolFail(target.error);
    const res = await api.request("POST", "/modules/core-scan/inbox/file-selected", {
      ids,
      target_module: target.module,
      target_kind: target.kind,
      ...(target.instance ? { instance: target.instance } : {}),
      // item id -> the catalog_candidates id get_scan_item offered it (#6888)
      ...(args.catalog_candidates && typeof args.catalog_candidates === "object" ? { catalog_entries: args.catalog_candidates } : {}),
    });
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "the items could not be filed"));
    const { filed, failed } = res.body as {
      filed: Array<{ item_id: string; entity_id: string; entity_kind: string; name: string }>;
      failed: Array<{ item_id: string; reason: string }>;
    };
    if (!filed.length) return toolFail(`Nothing was filed into ${target.label}: ${failed[0]?.reason ?? "no items"}`);
    return toolOk({ list: { name: target.instance ?? target.kind, label: target.label }, filed: filed.map(({ item_id, entity_id, entity_kind, name }) => ({ item_id, entity_id, entity_kind, name })), failed });
  },
};

export default tool;
