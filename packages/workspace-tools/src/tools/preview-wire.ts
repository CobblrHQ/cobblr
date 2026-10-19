import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "preview_wire",
  description: "Count the existing records a wire would fire on, and what the count means for its trigger. Use before add-wire.",
  mode: "read",
  paging: { by: "one-call", why: "a count and a sentence, not rows" },
  params: {
    source_kind: z.string(),
    trigger_type: z.string().optional().describe("As add-wire; default event"),
    filter: z.record(z.string(), z.unknown()).optional().describe("As add-wire"),
  },
  execute: async (api, args) => {
    const q = new URLSearchParams({
      source_kind: String(args.source_kind ?? ""),
      trigger_type: typeof args.trigger_type === "string" && args.trigger_type ? args.trigger_type : "event",
      ...(args.filter ? { filter: JSON.stringify(args.filter) } : {}),
    });
    const res = await api.request("GET", `/bindings/preview?${q}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't count what that wire would fire on"));
    return toolOk(res.body);
  },
};

export default tool;
