import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { ROLES_SAID, type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "add_thing",
  description:
    "The way to add a THING the person has. Runs the scan intake: duplicate check, table, fields, picture, place. Returns what it found, fields_refused (tell your person) and hints (empty fields: ask). Lands in the inbox; file: true files it. Several things in ONE photo: invoke_action core-scan:add-things-from-photo with the photo and a list, and Cobblr crops each.",
  mode: "write",
  params: {
    name: z.string(),
    goes_to: z.string().optional().describe("List your person named"),
    roles: z.record(z.unknown()).optional().describe(ROLES_SAID),
    identifier: z.string().optional().describe("Barcode, ISBN or model number"),
    url: z.string().optional(),
    image_file_id: z.string().optional(),
    place: z.string().optional(),
    location_id: z.string().optional(),
    fields: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    quantity: z.number().optional(),
    file: z.boolean().optional(),
    allow_duplicate: z.boolean().optional(),
  },
  execute: async (api, args) => {
    const res = await api.request("POST", "/modules/core-scan/scan/assistant", args as Record<string, unknown>);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "the add did not go through"));
    return toolOk(res.body);
  },
};

export default tool;
