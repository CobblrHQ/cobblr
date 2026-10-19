import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "labels",
  name: "list_label_codes",
  description:
    "Read label groups by kind and instance: prefix, count, frozen, code_in_qr and group_key. Change through labels:set-code without an entity, passing group_key and prefix/code_in_qr.",
  mode: "read",
  paging: { by: "one-call", why: "one row per label-code group; a workspace has a handful" },
  params: {},
  execute: async (api) => {
    const res = await api.request("GET", "/modules/labels/codes/groups");
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list label codes"));
    return toolOk((res.body as { groups?: unknown[] }).groups ?? []);
  },
};

export default tool;
