import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "read_view",
  // A saved view read as the person would see it, its inputs set (#6897):
  // "show the bread recipe for 12" reads the recipe view with Servings × 12
  // and opens it so. The inputs are bounded by the view; a value it had to
  // change comes back as a note to say.
  description:
    "Read a saved view's rows as shown, setting its inputs (a recipe's Servings ×, a batch size) when it has them, and open it on the person's screen. Inputs never change a record.",
  mode: "read",
  module: "core-views",
  paging: { by: "one-call", why: "one view's rows as shown, capped by limit; the person sees the whole view on the screen it opens" },
  params: {
    view: z.string().describe("The view's name as said, or its id (get_workspace_setup lists views)"),
    inputs: z.record(z.union([z.string(), z.number()])).optional().describe("The view's inputs by name, e.g. { scale: 12 }"),
    limit: z.number().optional().describe("Max rows (default 30, max 100)"),
  },
  execute: async (api, args) => {
    const said = String(args.view ?? "").trim();
    if (!said) return toolFail("say which view: its name or id");
    const listed = await api.request("GET", "/modules/core-views/views");
    if (listed.status >= 400) return toolFail(apiErrorMessage(listed, "couldn't list the views"));
    const views = ((listed.body?.items as Array<{ id: string; name: string; entity_kind: string }> | undefined) ?? []);
    const exact = views.filter((v) => v.id === said || v.name.toLowerCase() === said.toLowerCase());
    const found = exact.length ? exact : views.filter((v) => v.name.toLowerCase().includes(said.toLowerCase()));
    if (found.length !== 1) {
      return toolFail(found.length ? `"${said}" could be ${found.map((v) => v.name).join(", ")}: which one?` : `there is no view called "${said}"; the views are ${views.map((v) => v.name).join(", ") || "none yet"}`);
    }
    const view = found[0]!;
    const inputs = Object.fromEntries(Object.entries((args.inputs ?? {}) as Record<string, string | number>).map(([k, v]) => [k, String(v)]));
    const limit = Math.min(Number(args.limit) || 30, 100);
    const qs = new URLSearchParams({ limit: String(limit) });
    if (Object.keys(inputs).length) qs.set("inputs", JSON.stringify(inputs));
    const read = await api.request("GET", `/modules/core-views/views/${encodeURIComponent(view.id)}/data?${qs}`);
    if (read.status >= 400) return toolFail(apiErrorMessage(read, `couldn't read ${view.name}`));
    const body = read.body as { items?: unknown[]; total?: number; inputs?: { values: Record<string, unknown>; notes: Array<{ message: string }> } };
    // The page keeps the inputs in its address, so the screen opens scaled.
    const page = new URLSearchParams();
    for (const [k, v] of Object.entries(body.inputs?.values ?? {})) page.set(`in.${k}`, String(v));
    const path = `/views/${encodeURIComponent(view.id)}${page.size ? `?${page}` : ""}`;
    const items = Array.isArray(body.items) ? body.items : [];
    return toolOk({
      view: { name: view.name, of: view.entity_kind },
      ...(body.inputs ? { inputs: body.inputs.values, ...(body.inputs.notes.length ? { inputs_changed: body.inputs.notes.map((n) => n.message) } : {}) } : {}),
      items,
      shown: items.length,
      ...(typeof body.total === "number" ? { total: body.total } : {}),
      escort: { path, label: view.name },
      link: api.link?.({ app: path }) ?? null,
    });
  },
};

export default tool;
