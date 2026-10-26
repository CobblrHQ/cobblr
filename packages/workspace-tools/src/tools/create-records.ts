import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { fetchKinds, resolveCreatePath, recordCreateRefusal, withKindsTitleField } from "../kinds.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "create_records",
  description:
    "Create up to 200 records of one kind as one undoable set instead of calling create_record for each. Use its field names; report clashes instead of retrying.",
  mode: "write",
  params: {
    kind: z.string().describe("Entity kind id with can_create true"),
    records: z
      .array(z.record(z.unknown()))
      .min(1)
      .max(200)
      .describe("One object per record, each using the kind's exact field names"),
  },
  execute: async (api, args) => {
    const kind = String(args.kind ?? "");
    const rows = Array.isArray(args.records) ? (args.records as Array<Record<string, unknown>>) : [];
    if (rows.length === 0) return toolFail("no records given");
    const kinds = await fetchKinds(api);
    const refused = recordCreateRefusal(kind, kinds);
    if (refused) return toolFail(refused);
    const path = resolveCreatePath(kind, kinds);
    if (!path) return toolFail(`records of "${kind}" can't be created this way (no create route declared)`);
    const created: unknown[] = [];
    const failed: Array<{ index: number; error: string }> = [];
    for (const [i, row] of rows.entries()) {
      const { fields } = withKindsTitleField(kind, kinds, row);
      const res = await api.request("POST", `/${path}`, fields);
      if (res.status >= 400) failed.push({ index: i, error: apiErrorMessage(res, "create failed") });
      else created.push(res.body);
    }
    // None made is a failure, not an empty success: a lost connection or a
    // server error on every row was told as "created: 0, ok" (#6968).
    if (created.length === 0) return toolFail(failed[0]?.error ?? "no record was created");
    // Partial success is the NORMAL outcome here ("each rack should have
    // Shelf 1-5" against a rack that already has two of them), so it is
    // reported rather than thrown: the model needs to tell the person what
    // was already there instead of retrying into the same refusals.
    return toolOk({ created: created.length, failed, records: created });
  },
};

export default tool;
