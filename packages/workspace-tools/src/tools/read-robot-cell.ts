import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab", part: "arms",
  name: "read_robot_cell", description: "A cell's machines, job steps, state, jobs, step outcomes, commands.", mode: "read", paging: { by: "cursor" },
  params: { machine_id: z.string().uuid(), cursor: CURSOR_PARAM },
  execute: async (api, args) => {
    const cursor = decodeCursor<{ offset: number; machine_id: string }>("read_robot_cell", args.cursor);
    if (!cursor.ok) return toolFail(cursor.error);
    if (cursor.state && cursor.state.machine_id !== args.machine_id) return toolFail("Use this cell's cursor or omit it to start again.");
    const offset = cursor.state?.offset ?? 0;
    const res = await api.request("GET", `/modules/digifab/cells/${encodeURIComponent(String(args.machine_id))}?limit=20&offset=${offset}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "Could not read this cell"));
    const items = Array.isArray(res.body.items) ? res.body.items : [];
    const next = offset + items.length < Number(res.body.total) ? { offset: offset + items.length, machine_id: String(args.machine_id) } : null;
    return toolOk({ ...res.body, ...pageEnd("read_robot_cell", next) });
  },
};

export default tool;
