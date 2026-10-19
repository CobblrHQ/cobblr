import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "machines",
  name: "read_machine_versions",
  description: "Firmware/software versions by cohort: current, behind, unknown against each target; down for repair. Optional collection (e.g. 3d-printers), location_id.",
  mode: "read",
  paging: { by: "one-call", why: "One summary per cohort, not a list of records." },
  params: { collection: z.string().max(80).regex(/^[a-z0-9-]+$/).optional(), location_id: z.string().uuid().optional() },
  execute: async (api, args) => {
    const base = args.collection ? `/instances/${encodeURIComponent(String(args.collection))}/items/versions` : "/modules/machines/machines/versions";
    const res = await api.request("GET", args.location_id ? `${base}?location_id=${encodeURIComponent(String(args.location_id))}` : base);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "Could not read the machines' versions"));
    return toolOk(res.body);
  },
};

export default tool;
