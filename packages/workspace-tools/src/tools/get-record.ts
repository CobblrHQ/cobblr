import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { explainRecords } from "../field-meanings.js";
import { fetchKinds } from "../kinds.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_record",
  description: "Fetch one record by kind + id. Secrets report presence only; the person must use Reveal on the record.",
  mode: "read",
  paging: { by: "one-call", why: "one record by its id, with all its fields" },
  params: {
    kind: z.string().describe("Entity kind id"),
    id: z.string().describe("Record id"),
  },
  execute: async (api, args) => {
    const res = await api.request(
      "GET",
      `/entities/${encodeURIComponent(String(args.kind))}/${encodeURIComponent(String(args.id))}`,
    );
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "record not found"));
    return toolOk(explainRecords(res.body, await fetchKinds(api).catch(() => [])));
  },
};

export default tool;
