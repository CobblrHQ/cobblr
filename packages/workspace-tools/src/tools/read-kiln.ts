import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab",
  name: "read_kiln", description: "Kiln telemetry, wear, firing logs.", mode: "read", paging: { by: "cursor" },
  params: { machine_id: z.string().uuid(), cursor: CURSOR_PARAM },
  execute: async (api, args) => {
    const cursor = decodeCursor<{ offset: number; machine_id: string }>("read_kiln", args.cursor);
    if (!cursor.ok) return toolFail(cursor.error);
    if (cursor.state && cursor.state.machine_id !== args.machine_id) return toolFail("Use this kiln's cursor or omit it to start again.");
    const offset = cursor.state?.offset ?? 0;
    const res = await api.request("GET", `/modules/digifab/kilns/${encodeURIComponent(String(args.machine_id))}?limit=20&offset=${offset}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "Could not read this kiln"));
    const items = Array.isArray(res.body.items) ? res.body.items : [];
    const next = offset + items.length < Number(res.body.total) ? { offset: offset + items.length, machine_id: String(args.machine_id) } : null;
    return toolOk({ ...res.body, ...pageEnd("read_kiln", next) });
  },
};

export default tool;
