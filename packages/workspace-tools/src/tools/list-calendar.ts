import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type CalendarRow, type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_calendar",
  description:
    "Read dated tasks, maintenance, chores and deadlines. Dates are YYYY-MM-DD; defaults to the next 30 days.",
  mode: "read",
  paging: { by: "one-call", why: "everything in one date window; to see more, ask for another window" },
  params: {
    from: z.string().optional().describe("Window start, YYYY-MM-DD (default: today)"),
    to: z.string().optional().describe("Window end, YYYY-MM-DD (default: 30 days out)"),
  },
  execute: async (api, args) => {
    // The window has to be resolved to real dates, because the endpoint takes
    // an explicit range — a model asking "what's coming up" should not have to
    // know today's date to get an answer.
    const day = 24 * 60 * 60 * 1000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const now = Date.now();
    const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : iso(now);
    const to = typeof args.to === "string" && args.to.trim() ? args.to.trim() : iso(now + 30 * day);
    const res = await api.request(
      "GET",
      `/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the calendar"));
    const items = ((res.body as { items?: CalendarRow[] }).items ?? []).map((e) => ({
      date: e.date,
      title: e.title,
      from: e.source,
      ...(e.category ? { category: e.category } : {}),
      ...(e.location ? { where: e.location } : {}),
      ...(e.entityType ? { about: `${e.entityModule}:${e.entityType}`, entity_id: e.entityId } : {}),
    }));
    return toolOk({ window: { from, to }, items });
  },
};

export default tool;
