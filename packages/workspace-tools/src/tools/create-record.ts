import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { fetchKinds, resolveCreatePath, recordCreateRefusal, withKindsTitleField } from "../kinds.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "create_record",
  description:
    "Create ONE record. A physical thing the person owns: use add_thing. Use the kind's EXACT field names from list_record_kinds (knowledge entries want \"title\", parts \"name\"). Only kinds with can_create.",
  mode: "write",
  params: {
    kind: z.string().describe("Entity kind id with can_create true"),
    fields: z.record(z.unknown()).describe("The record's fields, using the kind's exact field names"),
  },
  execute: async (api, args) => {
    const kind = String(args.kind ?? "");
    const kinds = await fetchKinds(api);
    const refused = recordCreateRefusal(kind, kinds);
    if (refused) return toolFail(refused);
    const path = resolveCreatePath(kind, kinds);
    if (!path) return toolFail(`records of "${kind}" can't be created this way (no create route declared)`);
    // "title" when the kind says "name" is the same value under a different
    // word, and refusing it taught nobody anything (see withKindsTitleField).
    const { fields } = withKindsTitleField(kind, kinds, (args.fields as Record<string, unknown>) ?? {});
    const res = await api.request("POST", `/${path}`, fields);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "create failed"));
    return toolOk(res.body);
  },
};

export default tool;
