import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_putaway_plan",
  description:
    "The put-away situation: how many scanned items have no home, and the CURRENT organize plan (groups, destinations, evidence, unresolved). Use it when the user talks about putting things away, bins, or 'the plan'; places they describe become core-locations:location records (confirmed), which the plan routes to.",
  mode: "read",
  paging: { by: "one-call", why: "a summary of the standing plan (first 20 groups, 15 names each); the whole plan opens in the app" },
  params: {},
  execute: async (api) => {
    const [stats, latest] = await Promise.all([
      api.request("GET", "/modules/core-scan/inbox/stats"),
      api.request("GET", "/modules/core-scan/organize/plan/latest"),
    ]);
    if (stats.status >= 400) return toolFail(apiErrorMessage(stats, "couldn't read scan stats"));
    const planBody = (latest.body as { plan?: Record<string, unknown> | null }).plan ?? null;
    const groups = Array.isArray((planBody as { groups?: unknown[] } | null)?.groups)
      ? ((planBody as { groups: Array<Record<string, unknown>> }).groups ?? [])
      : [];
    const names = ((planBody as { item_names?: Record<string, string> } | null)?.item_names ??
      {}) as Record<string, string>;
    return toolOk({
      backlog: stats.body,
      plan: planBody
        ? {
            plan_id: (planBody as { plan_id?: unknown }).plan_id,
            hinted: !!(planBody as { draft_hinted?: unknown }).draft_hinted,
            applied_group_ids: (planBody as { applied_group_ids?: unknown }).applied_group_ids,
            groups: groups.slice(0, 20).map((g) => ({
              label: g.label,
              rationale: g.rationale,
              destination: g.destination,
              ai_guess: g.ai_guess ?? false,
              items: (Array.isArray(g.item_ids) ? (g.item_ids as string[]) : [])
                .slice(0, 15)
                .map((id) => names[id] ?? id),
            })),
          }
        : null,
      note: planBody
        ? "This is the standing plan the user sees. After you create/rename locations for them, call replan_putaway once — the open plan refreshes itself."
        : "No current plan — the user can open 'Put them away' to make one.",
    });
  },
};

export default tool;
