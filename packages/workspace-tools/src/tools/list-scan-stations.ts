import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_scan_stations",
  sentWhen: "scan-stations",
  description: "Your scan stations and their IDs, modes and active places. Read their sessions with list_scan_station_sessions.",
  mode: "read",
  paging: { by: "one-call", why: "every station configured by this person in this workspace" },
  params: {},
  execute: async (api) => {
    const res = await api.request("GET", "/scan-stations");
    return res.status >= 400 ? toolFail(apiErrorMessage(res, "couldn't read the stations")) : toolOk(res.body);
  },
};

export default tool;
