import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_my_notification_delivery",
  description:
    "Explain push delivery: devices, failures, thresholds, quiet hours, recent deliveries. Devices: invoke_action platform:test-push-device or platform:remove-push-device.",
  mode: "read",
  paging: { by: "one-call", why: "one person's few devices and the last ten notifications, a fixed-size answer" },
  params: {},
  execute: async (api) => {
    const res = await api.request("GET", "/my-push");
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read your notification delivery"));
    return toolOk(res.body);
  },
};

export default tool;
