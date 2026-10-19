import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "digifab",
  name: "read_fabrication_floor", description: "Machine queues, stock, batch layouts, restock.", mode: "read",
  paging: { by: "one-call", why: "Complete current floor state, not job history." }, params: {},
  execute: async api => {
    const [floor, fleet] = await Promise.all([api.request("GET", "/modules/digifab/floor"), api.request("GET", "/modules/digifab/fleet")]);
    for (const response of [floor, fleet]) if (response.status >= 400) return toolFail(apiErrorMessage(response, "Could not read the floor"));
    return toolOk({ ...floor.body, ...fleet.body });
  },
};

export default tool;
