import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { fetchKinds, fieldsByRole, resolveUpdatePath, withKindsTitleField } from "../kinds.js";
import { ROLES_SAID, type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "update_record",
  description:
    "Update fields on ONE existing record; only the fields you pass change. Only kinds with can_update.",
  mode: "write",
  params: {
    kind: z.string().describe("Entity kind id with can_update true"),
    id: z.string().describe("Record id"),
    fields: z.record(z.unknown()).optional().describe("The fields to change, using the kind's exact field names"),
    roles: z.record(z.unknown()).optional().describe(ROLES_SAID),
  },
  execute: async (api, args) => {
    const kind = String(args.kind ?? "");
    const kinds = await fetchKinds(api);
    const path = resolveUpdatePath(kind, String(args.id ?? ""), kinds);
    if (!path) return toolFail(`records of "${kind}" can't be updated this way (no update route declared)`);
    const byRole = fieldsByRole(kind, kinds, (args.roles as Record<string, unknown>) ?? {});
    const sent = { ...byRole.fields, ...((args.fields as Record<string, unknown>) ?? {}) };
    if (!Object.keys(sent).length) return toolFail(byRole.refused.length ? `nothing to change: ${byRole.refused.map((r) => `${r.name}: ${r.reason}`).join("; ")}` : "no fields or roles given");
    const { fields: patch } = withKindsTitleField(kind, kinds, sent);
    const res = await api.request("PATCH", `/${path}`, patch);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "update failed"));
    return toolOk(byRole.refused.length ? { ...(res.body as Record<string, unknown>), fields_refused: byRole.refused } : res.body);
  },
};

export default tool;
