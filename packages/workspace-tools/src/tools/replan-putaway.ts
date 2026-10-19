import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "replan_putaway",
  description:
    "Recompute the put-away plan against the CURRENT workspace; nothing is filed. Call ONCE after creating or renaming locations. Optional hint of what you learned (e.g. 'camping gear; the hallway closet holds electronics').",
  mode: "read",
  paging: { by: "one-call", why: "recomputes the plan; returns a status, not rows" },
  params: {
    hint: z
      .string()
      .optional()
      .describe("Optional ground truth for the planner, distilled from the conversation (max 500 chars)"),
  },
  execute: async (api, args) => {
    const hint = typeof args.hint === "string" && args.hint.trim() ? args.hint.trim().slice(0, 500) : undefined;
    const res = await api.request("POST", "/modules/core-scan/organize/plan", {
      scope: "pending",
      fresh: true,
      ...(hint ? { hint } : {}),
    });
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't re-plan"));
    const body = res.body as {
      plan_id?: unknown;
      groups?: Array<Record<string, unknown>>;
      item_names?: Record<string, string>;
    };
    const names = body.item_names ?? {};
    return toolOk({
      plan_id: body.plan_id,
      groups: (body.groups ?? []).slice(0, 20).map((g) => ({
        label: g.label,
        destination: g.destination,
        items: (Array.isArray(g.item_ids) ? (g.item_ids as string[]) : [])
          .slice(0, 15)
          .map((id) => names[id] ?? id),
      })),
      note: "The user's open plan refreshes itself, summarize what changed instead of pasting the whole plan.",
    });
  },
};

export default tool;
