import { toolOk } from "../api.js";
import { fetchKinds, resolveCreatePath, summarizeKind } from "../kinds.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_record_kinds",
  description:
    "List all module and user-app record kinds, fields and CRUD permissions. Read before querying or creating an unfamiliar kind.",
  mode: "read",
  paging: { by: "one-call", why: "every kind this workspace has; a workspace has tens, not thousands" },
  params: {},
  execute: async (api) => {
    const kinds = await fetchKinds(api);
    return toolOk(
      kinds.map((k) => ({
        ...summarizeKind(k),
        can_create: k.can_create !== false && resolveCreatePath(k.id, kinds) !== null,
      })),
    );
  },
};

export default tool;
