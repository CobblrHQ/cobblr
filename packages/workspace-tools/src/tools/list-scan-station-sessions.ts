import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_scan_station_sessions",
  sentWhen: "scan-stations",
  description: "What a scan station did, by session and time. Read a session's actions with get_scan_station_session.",
  mode: "read",
  paging: { by: "cursor" },
  params: { device_id: z.string().uuid(), cursor: CURSOR_PARAM },
  execute: async (api, args) => {
    const cur = decodeCursor<{ device: string; before: string }>("list_scan_station_sessions", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const device = cur.state?.device || String(args.device_id);
    const before = cur.state?.before;
    const res = await api.request("GET", `/scan-stations/${encodeURIComponent(device)}/sessions${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the sessions"));
    const body = res.body as { items: unknown[]; next_before: string | null };
    return toolOk({ items: body.items, ...pageEnd("list_scan_station_sessions", body.next_before ? { device, before: body.next_before } : null) });
  },
};

export default tool;
