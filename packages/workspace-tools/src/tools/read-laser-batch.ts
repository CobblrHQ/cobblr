import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab",
  name: "read_laser_batch",
  description: "Read workshop plans and state.",
  mode: "read",
  paging: { by: "cursor" },
  params: {
    operation: z.enum(["design", "plans", "profiles", "setup", "cutter_profiles", "cutter_station", "large_format_station", "large_format_jobs", "machines", "designs", "runs", "spools", "chart", "stations"]),
    id: z.string().describe("Drawing/conn/machine; spools: design; lists: empty"),
    device_id: z.string().optional(),
    units: z.enum(["mm", "in"]).optional(),
    q: z.string().max(200).optional(),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, args) => {
    const cursor = decodeCursor<{ offset: number; id: string; operation: string; device_id?: string; q?:string }>("read_laser_batch", args.cursor);
    if (!cursor.ok) return toolFail(cursor.error);
    if (cursor.state && (cursor.state.id !== args.id || cursor.state.operation !== args.operation || (cursor.state.q ?? "") !== (args.q ?? "") || ["cutter_profiles", "large_format_jobs"].includes(cursor.state.operation) && cursor.state.device_id !== args.device_id)) return toolFail("Use the cursor for this drawing and operation, or omit it to start again.");
    const id = encodeURIComponent(String(args.id ?? ""));
    const offset = cursor.state?.offset ?? 0;
    let path: string;
    if (["machines","designs","runs","spools","chart","stations"].includes(String(args.operation))) {
      const operation = String(args.operation);
      const search=`&q=${encodeURIComponent(String(args.q??""))}${operation==="spools"&&args.id?`&design_id=${id}`:""}`;
      path = operation === "runs" ? `/modules/digifab/embroidery/runs?machine_id=${id}&limit=20&offset=${offset}` : operation === "stations" ? `/modules/digifab/embroidery/machines/${id}/stations?limit=20&offset=${offset}${search}` : `/modules/digifab/embroidery/${operation}?limit=20&offset=${offset}${search}`;
    }
    else if (args.operation === "design") path = `/modules/digifab/laser/design/${id}?units=${args.units === "in" ? "in" : "mm"}`;
    else if (args.operation === "plans") path = `/modules/digifab/laser/plans?library_id=${id}&limit=20&offset=${offset}`;
    else if (args.operation === "profiles") path = `/modules/digifab/laser/profiles?connection_id=${id}&device_id=${encodeURIComponent(String(args.device_id ?? ""))}`;
    else if (args.operation === "cutter_profiles" || args.operation === "cutter_station") {
      if (!args.device_id) return toolFail("Choose a cutter device id.");
      path = `/modules/digifab/cutter/${args.operation === "cutter_profiles" ? "profiles" : "station"}?connection_id=${id}&device_id=${encodeURIComponent(String(args.device_id))}&limit=20&offset=${offset}`;
    }
    else if (args.operation === "large_format_station" || args.operation === "large_format_jobs") {
      if (!args.device_id) return toolFail("Choose a printer device id.");
      path = `/modules/digifab/large-format/${args.operation === "large_format_station" ? "station" : "jobs"}?connection_id=${id}&device_id=${encodeURIComponent(String(args.device_id))}&limit=20&offset=${offset}`;
    }
    else if (args.operation === "setup") {
      if (!args.device_id) return toolFail("Choose a device id for this laser connection.");
      path = `/modules/digifab/laser/setup?connection_id=${id}&device_id=${encodeURIComponent(String(args.device_id))}`;
    }
    else return toolFail("Choose design, plans, profiles or setup.");
    const res = await api.request("GET", path);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "Could not read the laser batch"));
    const items = Array.isArray(res.body.items) ? res.body.items : [];
    const next = (["plans", "cutter_profiles", "large_format_jobs"].includes(String(args.operation)) || ["machines","designs","runs","spools","chart","stations"].includes(String(args.operation))) && offset + items.length < Number(res.body.total) ? { offset: offset + items.length, id: String(args.id), operation: String(args.operation), ...(args.q?{q:String(args.q)}:{}), ...(["cutter_profiles", "large_format_jobs"].includes(String(args.operation)) ? {device_id:String(args.device_id)} : {}) } : null;
    return toolOk({ ...res.body, ...pageEnd("read_laser_batch", next) });
  },
};

export default tool;
