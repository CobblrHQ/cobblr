import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type AppRow, type BindingRow, type InstanceRow, type TemplateRow, type UnitVocabularyRow, type ViewRow, type WorkspaceTool } from "../tool-kit.js";

const PARTS = ["all", "instances", "views", "automations", "relationships", "apps", "templates", "units", "devices", "ai"] as const;

const tool: WorkspaceTool = {
  name: "get_workspace_setup",
  description:
    "Read setup. Use part=devices to discover bridge machines.",
  mode: "read",
  paging: { by: "one-call", why: "a description of the setup, one area or a summary of all" },
  params: {
    part: z
      .enum(PARTS)
      .optional()
      .describe("Area; default all"),
    bridge:z.string().max(60).optional().describe("Devices: bridge name; omit for default"),
  },
  execute: async (api, args) => {
    const part = typeof args.part === "string" && args.part ? args.part : "all";
    // An area this tool does not read is not an area switched off. Asked for
    // "fields", it said "not available in this workspace (its module may not
    // be enabled)", and the model told the person their Colour field did not
    // exist (#8331). A provider that ignores the enum gets the list instead.
    if (!(PARTS as readonly string[]).includes(part)) {
      return toolFail(
        `get_workspace_setup has no "${part}" area; it reads ${PARTS.filter((p) => p !== "all").join(", ")}.` +
          (part === "fields" || part === "kinds" ? " A kind's fields are read with list_record_kinds." : ""),
      );
    }
    if(part === "devices") {
      const res=await api.request("GET",`/edge/discovery${args.bridge?`?bridge=${encodeURIComponent(String(args.bridge))}`:""}`);
      if(res.status>=400)return toolFail(apiErrorMessage(res,"Could not discover devices"));
      return toolOk(res.body);
    }
    const want = (p: string) => part === "all" || part === p;
    // Each area is optional: a workspace that has not enabled a module 404s
    // that one, and the honest answer is "that area is not set up here" — not
    // a failed tool call that loses the six areas that DID answer.
    const grab = async <T>(path: string, pick: (body: Record<string, unknown>) => T): Promise<T | null> => {
      const res = await api.request("GET", path);
      if (res.status >= 400) return null;
      try {
        return pick(res.body);
      } catch {
        return null;
      }
    };
    const out: Record<string, unknown> = {};

    if (want("instances")) {
      const rows = await grab("/instances", (b) => (b.items as InstanceRow[] | undefined) ?? []);
      if (rows) {
        out.instances = rows.map((i) => ({
          name: i.display_name,
          instance: i.instance_name,
          from_module: i.module_name,
          ...(i.is_default ? { is_default: true } : {}),
          ...(typeof i.item_count === "number" ? { items: i.item_count } : {}),
          // The kind id is what every OTHER tool needs to act on this list.
          kind: `${i.instance_name}:item`,
        }));
      }
    }
    if (want("views")) {
      const rows = await grab("/modules/core-views/views", (b) => (b.items as ViewRow[] | undefined) ?? []);
      if (rows) {
        out.views = rows.map((v) => ({
          name: v.name,
          of: v.entity_kind,
          shown_as: v.view_type,
          ...(v.is_default ? { is_default: true } : {}),
          ...(v.pinned ? { pinned_to_dashboard: true } : {}),
        }));
      }
    }
    if (want("automations")) {
      const rows = await grab("/bindings", (b) => (b.items as BindingRow[] | undefined) ?? []);
      if (rows) {
        out.automations = rows.map((w) => ({
          does: w.action_id,
          on: w.source_kind,
          when:
            w.trigger_type === "schedule"
              ? `on a schedule (${w.trigger_schedule ?? "unspecified"})`
              : w.trigger_type === "event"
                ? `the event ${w.trigger_event ?? "?"}`
                : w.trigger_type,
          // A disabled wire explains a "why didn't that happen" as surely as an
          // enabled one explains a "why did that happen".
          ...(w.enabled === false ? { enabled: false } : {}),
          id: w.id,
        }));
      }
    }
    // The links a wire can run on (target {rel, dir}), by name, so one that
    // is drafted names a relationship that exists.
    if (want("relationships")) {
      const rows = await grab("/relationship-kinds", (b) => (b.items as Array<{ relationship: string; count: number }> | undefined) ?? []);
      if (rows) out.relationships = rows.map((r) => ({ relationship: r.relationship, links: r.count }));
    }
    if (want("apps")) {
      const rows = await grab("/modules/core-apps/apps", (b) => (b.items as AppRow[] | undefined) ?? []);
      if (rows) out.apps = rows.map((a) => ({ name: a.name, slug: a.slug }));
    }
    if (want("templates")) {
      const rows = await grab(
        "/modules/core-templates/templates",
        (b) => (b.items as TemplateRow[] | undefined) ?? [],
      );
      if (rows) {
        out.templates = rows.map((t) => ({
          name: t.name,
          creates: t.target_kind,
          ...(t.description ? { description: t.description } : {}),
          // The values themselves, so "a new one from the PLA template" is a
          // create_record with them and a tag_record per tag (#6947).
          prefills: t.defaults ?? {},
          ...(t.default_tags?.length ? { tags: t.default_tags } : {}),
        }));
      }
    }
    if (want("units")) {
      const vocab = await grab("/modules/core-units/units", (b) => b as unknown as UnitVocabularyRow);
      if (vocab) {
        out.units = {
          // Only the CUSTOM ones are a fact about this workspace; the builtins
          // are the same everywhere and would be noise in every answer.
          custom: (vocab.custom ?? []).map((u) => `${u.name} (${u.symbol})`),
          builtin_count: (vocab.builtins ?? []).length,
          ...(vocab.display_mode ? { display_mode: vocab.display_mode } : {}),
        };
      }
    }

    // Who answers each AI job here, and who reads personal documents: read
    // only. Changing them is the owner's on the AI page; turning the cloud
    // on for personal documents is a person's consent, never the assistant's.
    if (want("ai")) {
      const order = await grab("/ai-job-order", (b) =>
        ((b.jobs as Array<{ title: string; chosen: boolean; steps: Array<{ label: string; model: string; model_label?: string }> }> | undefined) ?? []).map((j) => ({
          job: j.title,
          set_here: j.chosen,
          steps: j.steps.map((st) => `${st.label} · ${st.model_label ?? st.model}`),
        })),
      );
      const reader = await grab("/personal-documents-reader", (b) => {
        const r = b.reader as { kind: string; label?: string; company?: string; consented_by?: string | null; consented_at?: string };
        return r.kind === "cloud"
          ? `Sent to ${r.company} (${r.label}), consented by ${r.consented_by ?? "the owner"} on ${r.consented_at?.slice(0, 10)}`
          : "Read on this machine only (code, plus a local AI if one is connected)";
      });
      if (order || reader) out.ai = { ...(order ? { who_answers: order } : {}), ...(reader ? { personal_documents: reader } : {}) };
    }

    const areas = Object.keys(out);
    if (areas.length === 0) {
      return toolOk({
        note:
          part === "all"
            ? "None of these areas are set up in this workspace yet."
            : `The ${part} area is not available in this workspace (its module may not be enabled).`,
      });
    }
    return toolOk(out);
  },
};

export default tool;
