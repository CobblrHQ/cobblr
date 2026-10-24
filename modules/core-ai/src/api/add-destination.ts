import type { WorkspaceApi } from "@cobblr/workspace-tools";
import type { ToolCall } from "../providers/tool-wire.js";

export async function workspaceAsList(call: ToolCall, workspaceName: string, api: WorkspaceApi): Promise<string | null> {
  if (call.name !== "add_thing") return null;
  const said = call.args?.goes_to;
  const normal = (value: string) => value.trim().toLowerCase();
  if (typeof said !== "string" || !normal(said) || normal(said) !== normal(workspaceName)) return null;

  const menu = await api.request("GET", "/modules/core-scan/menu").catch(() => null);
  if (!menu || menu.status >= 400 || !Array.isArray(menu.body.items)) {
    return `I could not check whether "${said.trim()}" names a list or only the workspace. Ask which list to use before adding it.`;
  }
  const lists = menu.body.items as Array<{ label: string; kind: string; instance?: string | null; noun: string }>;
  if (lists.some((list) => [list.label, list.kind, list.instance, list.noun].some((name) => typeof name === "string" && normal(name) === normal(said)))) return null;
  return `"${said.trim()}" is the workspace name, not a list. The lists are: ${lists.map((list) => list.label).join(", ") || "none"}. ` +
    "Use the appropriate existing list for goes_to, or ask which list to use. Keep the name, quantity and place unchanged. To add it to that list now, pass file: true.";
}
