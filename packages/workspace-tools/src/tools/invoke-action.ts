import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "invoke_action",
  description:
    "Run an action from list_actions. Entity actions need entity_kind and entity_id; workspace actions omit both. Pass its args.",
  mode: "write",
  params: {
    action_id: z.string().describe("Action id, e.g. inventory:adjust-stock or labels:set-code"),
    entity_kind: z
      .string()
      .optional()
      .describe("The record's kind id — required for an entity action, omit for a workspace action"),
    entity_id: z
      .string()
      .optional()
      .describe("The record's id — required for an entity action, omit for a workspace action"),
    args: z.record(z.unknown()).optional().describe("Action arguments, by name, from the action's `args` in list_actions. Values may be any JSON — a string, a number, or a LIST (e.g. reorder takes ids: [\"…\",\"…\"])."),
  },
  execute: async (api, args) => {
    const entityKind = typeof args.entity_kind === "string" && args.entity_kind.trim() ? args.entity_kind.trim() : undefined;
    const entityId = typeof args.entity_id === "string" && args.entity_id.trim() ? args.entity_id.trim() : undefined;
    const res = await api.request("POST", "/actions/invoke", {
      actionId: String(args.action_id ?? ""),
      // Omitted entirely for a workspace action — the server skips entity
      // resolution when the action's scope is 'workspace'.
      ...(entityKind ? { entityKind } : {}),
      ...(entityId ? { entityId } : {}),
      args: (args.args as Record<string, unknown> | undefined) ?? undefined,
    });
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "action failed"));
    // The route answers 200 when the action was INVOKED; whether the operation
    // went ahead is the handler's own `result.ok`, and a handler that refuses
    // (a frozen label group, a unit that already ships built in, an argument
    // that doesn't resolve) says so there. Reading only the HTTP status
    // reported every one of those refusals to the model as a success — so it
    // told the user the change was made. 136 refusal paths across ~20 modules
    // are reachable through this one tool; unwrapping the envelope is what
    // makes "it wouldn't let me, because…" sayable at all.
    const body = res.body as { result?: unknown };
    const inner = body.result;
    if (inner && typeof inner === "object" && (inner as { ok?: unknown }).ok === false) {
      const reason = (inner as { error?: unknown }).error;
      return toolFail(
        typeof reason === "string" && reason.trim() ? reason : "the action declined to run",
      );
    }
    return toolOk(res.body);
  },
};

export default tool;
