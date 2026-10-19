import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type ScanItemRow, type WorkspaceTool, scanItemDetail } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_scan_item",
  description:
    "ONE inbox item: fields, source, confidence, why flagged, destination, catalog_candidates, pictures, history.",
  mode: "read",
  paging: { by: "one-call", why: "one item, whole; its history is capped at the last few steps" },
  params: {
    id: z.string().describe("An id from list_scan_inbox"),
  },
  execute: async (api, args) => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return toolFail("id is required: take one from list_scan_inbox");
    const res = await api.request("GET", `/modules/core-scan/inbox/${encodeURIComponent(id)}`);
    if (res.status === 404) return toolFail(`no scan inbox item ${id}: list_scan_inbox gives the ids that exist`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read that scan item"));
    // The catalog entries it could be (#6888), by part number or a strong
    // name, never by asking a model from a read. Absent when none applies.
    const cat = await api.request("GET", `/modules/core-scan/inbox/${encodeURIComponent(id)}/catalog-candidates?ai=0`);
    const catalog = cat.status < 400 ? ((cat.body as { candidates?: unknown[] }).candidates ?? []) : [];
    return toolOk({ ...scanItemDetail(res.body as ScanItemRow, api), ...(catalog.length ? { catalog_candidates: catalog } : {}) });
  },
};

export default tool;
