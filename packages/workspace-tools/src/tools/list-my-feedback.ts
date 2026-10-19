import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_my_feedback",
  description: "Read your own workspace feedback and replies.",
  mode: "read",
  paging: { by: "cursor" },
  params: { cursor: CURSOR_PARAM },
  execute: async (api, args) => {
    const cur = decodeCursor<{ after: string }>("list_my_feedback", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const query = cur.state ? `?cursor=${encodeURIComponent(cur.state.after)}` : "";
    const res = await api.request("GET", `/feedback/mine${query}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read your feedback"));
    const next = typeof res.body.next_cursor === "string" ? { after: res.body.next_cursor } : null;
    return toolOk({ items: res.body.items, total: res.body.total, ...pageEnd("list_my_feedback", next) });
  },
};

export default tool;
