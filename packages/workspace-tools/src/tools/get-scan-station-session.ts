import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_scan_station_session",
  sentWhen: "scan-stations",
  description: "A station session in full: each action, the thing, its place before and after, and whether it was undone.",
  mode: "read",
  paging: { by: "one-call", why: "one session in full; the station starts another after 500 actions" },
  params: { device_id: z.string().uuid(), session_id: z.string().uuid() },
  execute: async (api, args) => {
    const res = await api.request("GET", `/scan-stations/${encodeURIComponent(String(args.device_id))}/sessions/${encodeURIComponent(String(args.session_id))}`);
    return res.status >= 400 ? toolFail(apiErrorMessage(res, "couldn't read the session")) : toolOk(res.body);
  },
};

export default tool;
