import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab",
  name: "read_print_history", description: "Finished prints over the last N days: counts, filament, hours, what they cost (unpriced counted apart), per printer and per day.", mode: "read",
  paging: { by: "one-call", why: "One window's totals; the 50 newest prints ride along." }, params: { days: z.number().int().min(1).max(365).optional() },
  execute: async (api, args) => {
    const days = Number(args.days ?? 30);
    const result = await api.request("GET", `/modules/digifab/history?days=${days}`);
    if (result.status >= 400) return toolFail(apiErrorMessage(result, "Could not read the print history"));
    return toolOk(result.body);
  },
};

export default tool;
