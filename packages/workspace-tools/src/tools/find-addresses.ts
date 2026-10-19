import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "find_addresses",
  description:
    "Find addresses this workspace already used, by a place's name or street: \"mvc\" finds MVC Lodi Agency. Use before writing an address field so a place is written the same way; no match: write it as the person said it.",
  mode: "read",
  paging: { by: "one-call", why: "the few best matches; ask with more of the name or street to narrow" },
  params: {
    q: z.string().min(1).describe("Part of the place's name or street, as the person said it"),
  },
  execute: async (api, args) => {
    const res = await api.request("GET", `/addresses?q=${encodeURIComponent(String(args.q))}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the addresses"));
    const body = res.body as { used?: Array<{ address: Record<string, unknown>; usedOn: { kind: string; id: string; name: string }; uses: number }>; found?: Array<Record<string, unknown>> };
    return toolOk({
      items: [
        ...(body.used ?? []).map((u) => ({ address: u.address, used_on: u.usedOn, uses: u.uses })),
        ...(body.found ?? []).map((f) => ({ address: f, from: "map search" })),
      ],
    });
  },
};

export default tool;
