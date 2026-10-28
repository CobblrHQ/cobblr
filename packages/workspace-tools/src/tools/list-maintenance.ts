import { addressText } from "@cobblr/platform-contract/address";
import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { LIST_LIMIT_MAX, type MaintenanceRow, type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  module: "core-maintenance",
  name: "list_maintenance",
  description:
    "Read service reminders and history. Set terms for paid renewal terms, receipts and spend totals.",
  mode: "read",
  paging: { by: "cursor" },
  params: {
    terms: z.boolean().optional(),
    year: z.number().int().optional(),
    due: z.boolean().optional().describe("Only scheduled, not yet done"),
    history: z.boolean().optional().describe("Only work already done"),
    within_days: z.number().optional().describe("With due: only what falls due inside this many days"),
    entity_id: z.string().optional().describe("Only maintenance for this record"),
    limit: z.number().optional().describe(`Max entries (default 25, max ${LIST_LIMIT_MAX})`),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, rawArgs) => {
    // The cursor carries the filters it was made for, so page two is page
    // two of the same question.
    const cur = decodeCursor<{ o: number; f: Record<string, unknown> }>("list_maintenance", rawArgs.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const args: Record<string, unknown> = cur.state?.f ?? rawArgs;
    const offset = cur.state?.o ?? 0;
    const limit = Math.min(Number(args.limit) || 25, LIST_LIMIT_MAX);
    // Filter at the source: the route already understands scheduled-vs-history
    // and a due window, so a page of 25 is 25 of the RIGHT rows rather than 25
    // of everything, sifted here.
    // One past the page, to know without a count whether there is another.
    const q: string[] = [`limit=${limit + 1}`, `offset=${offset}`];
    if (args.due === true) q.push("kind=scheduled");
    else if (args.history === true) q.push("kind=history");
    const within = Number(args.within_days);
    if (args.due === true && Number.isFinite(within) && within > 0)
      q.push(`due_within_days=${Math.floor(within)}`);
    if (typeof args.entity_id === "string" && args.entity_id.trim())
      q.push(`entity_id=${encodeURIComponent(args.entity_id.trim())}`);
    if (args.terms === true) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (args.entity_id) params.set("entity_id", String(args.entity_id));
      if (args.year != null) params.set("year", String(args.year));
      const res = await api.request("GET", `/modules/core-maintenance/terms?${params}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "Couldn't read renewal terms"));
      const body = res.body as { items: unknown[]; has_more: boolean; totals: unknown };
      const { cursor: _c, ...filters } = args;
      return toolOk({ items: body.items, totals: body.totals, ...pageEnd("list_maintenance", body.has_more ? { o: offset + body.items.length, f: filters } : null) });
    }
    const res = await api.request("GET", `/modules/core-maintenance/entries?${q.join("&")}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read maintenance"));
    const rows = ((res.body as { items?: MaintenanceRow[] }).items ?? []).map((e) => ({
      id: e.id,
      what: e.name,
      on: e.entity_type ? `${e.entity_module}:${e.entity_type}` : null,
      entity_id: e.entity_id,
      ...(e.scheduled_at ? { scheduled: e.scheduled_at } : {}),
      ...(e.performed_at ? { done: e.performed_at } : { outstanding: true }),
      ...(e.counter_reading != null ? { counter_reading: Number(e.counter_reading) } : {}),
      ...(e.recurrence_rule ? { repeats: e.recurrence_rule } : {}),
      ...((e as MaintenanceRow & { schedule?: unknown }).schedule ? { schedule: (e as MaintenanceRow & { schedule?: unknown }).schedule } : {}),
      ...((e as MaintenanceRow & { nag_stopped_at?: unknown }).nag_stopped_at ? { reminders_off: true } : {}),
      ...((e as MaintenanceRow & { nag_snoozed_until?: unknown }).nag_snoozed_until ? { snoozed_until: (e as MaintenanceRow & { nag_snoozed_until?: unknown }).nag_snoozed_until } : {}),
      ...(e.notes ? { notes: e.notes } : {}),
      ...(addressText(e.address) ? { where: addressText(e.address) } : {}),
    }));
    const { cursor: _c, ...filters } = args;
    return toolOk({
      items: rows.slice(0, limit),
      ...pageEnd("list_maintenance", rows.length > limit ? { o: offset + limit, f: filters } : null),
    });
  },
};

export default tool;
