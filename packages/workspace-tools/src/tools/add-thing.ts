import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { ROLES_SAID, type WorkspaceTool } from "../tool-kit.js";

const unsaid = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && !v.trim()) || (typeof v === "object" && Object.keys(v as object).length === 0);

/** An add as the intake can take it. A model marks a role nobody said with
 *  null or {} ("acquired-for": {} for a printer with no price, walk #9477),
 *  which the intake refuses as a value, so the card confirmed into
 *  "Roles acquired for: Invalid input". Unsaid is absent. A name put in
 *  fields is the thing's name. */
export function addThingArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (unsaid(v)) continue;
    if ((k === "roles" || k === "fields") && typeof v === "object" && !Array.isArray(v)) {
      const kept = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => !unsaid(x)));
      if (Object.keys(kept).length) out[k] = kept;
      continue;
    }
    out[k] = v;
  }
  const fields = out.fields as Record<string, unknown> | undefined;
  if (typeof out.name !== "string" || !out.name.trim()) {
    const named = fields?.name ?? fields?.title;
    if (typeof named === "string" && named.trim()) {
      out.name = named.trim();
      const { name: _n, title: _t, ...rest } = fields!;
      if (Object.keys(rest).length) out.fields = rest;
      else delete out.fields;
    } else delete out.name;
  }
  return out;
}

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
    const body = addThingArgs(args as Record<string, unknown>);
    if (!body.name) return toolFail("name is required: the thing as your person called it");
    const res = await api.request("POST", "/modules/core-scan/scan/assistant", body);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "the add did not go through"));
    return toolOk(res.body);
  },
};

export default tool;
