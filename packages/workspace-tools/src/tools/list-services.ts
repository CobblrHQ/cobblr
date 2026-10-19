import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_services",
  sentWhen: "services",
  description:
    "The outside services usable here, by capability (design.part, slice.model, ...): summary, effect, input schema, files. Pass capability for one service's options too (templates, printer models). Start one with invoke_service.",
  mode: "read",
  paging: { by: "one-call", why: "one row per connected capability; a workspace has a handful" },
  params: { capability: z.string().optional() },
  execute: async (api, args) => {
    const one = typeof args.capability === "string" && args.capability.trim() ? args.capability.trim() : null;
    if (one) {
      const r = await api.request("GET", `/services/capabilities/${encodeURIComponent(one)}`);
      if (r.status >= 400) return toolFail(apiErrorMessage(r, `couldn't read ${one}`));
      const c = r.body as { id?: string; title?: string; summary?: string; effect?: string; input_schema?: unknown; options?: unknown };
      return toolOk({ capability: c.id, title: c.title, summary: c.summary, effect: c.effect, input_schema: c.input_schema, options: c.options ?? null });
    }
    const res = await api.request("GET", "/services/capabilities");
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list services"));
    const items = ((res.body.items ?? res.body) as Array<{
      id?: string;
      title?: string;
      summary?: string;
      effect?: string;
      input_schema?: unknown;
      files_in?: Array<{ name?: string; types?: string[]; required?: boolean; multiple?: boolean }>;
      answered_by?: Array<{ label?: string }>;
    }>) ?? [];
    return toolOk(
      items.map((c) => ({
        capability: c.id,
        title: c.title,
        summary: c.summary,
        effect: c.effect,
        input_schema: c.input_schema,
        files: (c.files_in ?? []).map((f) => ({ name: f.name, types: f.types, required: !!f.required, ...(f.multiple ? { multiple: true, key: `${f.name}/<label>` } : {}) })),
        answered_by: c.answered_by?.[0]?.label ?? null,
      })),
    );
  },
};

export default tool;
