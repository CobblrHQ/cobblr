import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab",
  name: "read_machine_care", description: "A machine's alarms, acknowledgements and observed use (run, idle, fault, unseen).", mode: "read", paging: { by: "cursor" },
  params: { machine_id: z.string().uuid(), hours: z.number().int().min(1).max(2160).optional(), cursor: CURSOR_PARAM },
  execute: async (api, args) => {
    const cursor = decodeCursor<{ offset: number; machine_id: string }>("read_machine_care", args.cursor);
    if (!cursor.ok) return toolFail(cursor.error);
    if (cursor.state && cursor.state.machine_id !== args.machine_id) return toolFail("Use this machine's cursor or omit it to start again.");
    const offset = cursor.state?.offset ?? 0;
    const res = await api.request("GET", `/modules/digifab/care/${encodeURIComponent(String(args.machine_id))}?limit=20&offset=${offset}${args.hours ? `&hours=${Number(args.hours)}` : ""}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "Could not read this machine's alarms"));
    const items = Array.isArray(res.body.items) ? res.body.items : [];
    const next = offset + items.length < Number(res.body.total) ? { offset: offset + items.length, machine_id: String(args.machine_id) } : null;
    return toolOk({ ...res.body, ...pageEnd("read_machine_care", next) });
  },
};

export default tool;
