import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { fetchKinds, resolveDeletePath } from "../kinds.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "delete_record",
  description:
    "Delete ONE record (kinds with can_delete). Check it is the right one (get_record) first. From outside Cobblr it waits for the person's yes.",
  mode: "write",
  params: {
    kind: z.string().describe("Entity kind id with can_delete true"),
    id: z.string().describe("Record id"),
  },
  execute: async (api, args) => {
    const kind = String(args.kind ?? "");
    const kinds = await fetchKinds(api);
    const path = resolveDeletePath(kind, String(args.id ?? ""), kinds);
    if (!path) return toolFail(`records of "${kind}" can't be deleted this way (no delete route declared)`);
    const rec = kinds.find((k) => k.id === kind);
    if (rec?.can_delete === false) return toolFail(rec.delete_refused ?? "this person may not delete records of this kind");
    const res = await api.request("DELETE", `/${path}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "delete failed"));
    // Over a connection from outside Cobblr the delete waits for the person:
    // say so, or the assistant reports a deletion that has not happened.
    if (res.status === 202 && (res.body as { held?: unknown }).held === true) {
      return toolOk({ deleted: false, waiting_for_person: true, message: (res.body as { message?: string }).message });
    }
    return toolOk(res.status === 204 ? { deleted: true } : res.body);
  },
};

export default tool;
