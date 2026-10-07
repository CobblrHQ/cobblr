import type { ToolCall } from "../providers/tool-wire.js";
import { resolveActionId } from "./act-dont-escort.js";

export function actionToolCall(call: ToolCall, actionIds: readonly string[]): ToolCall {
  if (!call.name.includes(":")) return call;
  const actionId = resolveActionId(call.name, actionIds);
  if (!actionId) return call;
  const { entity_kind, entity_id, args, ...rest } = call.args;
  const nested = args && typeof args === "object" && !Array.isArray(args);
  const scoped = nested || entity_id !== undefined;
  return {
    ...call,
    name: "invoke_action",
    args: {
      action_id: actionId,
      ...(scoped && entity_kind !== undefined ? { entity_kind } : {}),
      ...(entity_id !== undefined ? { entity_id } : {}),
      args: nested ? args : scoped ? rest : call.args,
    },
  };
}
