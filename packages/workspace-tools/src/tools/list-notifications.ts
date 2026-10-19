import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type NotificationRow, type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_notifications",
  description:
    "Read your workspace notifications, newest first.",
  mode: "read",
  paging: { by: "cursor" },
  params: {
    unread_only: z.boolean().optional().describe("Only notifications they have not read"),
    limit: z.number().optional().describe("Max notifications (default 25, max 100)"),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, args) => {
    const cur = decodeCursor<{ b: string; u?: boolean; l: number }>("list_notifications", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const st = cur.state;
    const limit = st?.l ?? Math.min(Number(args.limit) || 25, 100);
    const unreadOnly = st ? st.u === true : args.unread_only === true;
    const unread = unreadOnly ? "&unread=1" : "";
    const before = st ? `&before=${encodeURIComponent(st.b)}` : "";
    const [res, count] = await Promise.all([
      api.request("GET", `/notifications?limit=${limit}${unread}${before}`),
      api.request("GET", "/notifications/unread-count"),
    ]);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read notifications"));
    const body = res.body as { items?: NotificationRow[]; next_before?: string | null };
    const items = (body.items ?? []).map((n) => ({
      when: n.created_at,
      message: n.message,
      about: n.event_type,
      unread: !n.read_at,
      ...(n.link_url ? { link: n.link_url } : {}),
    }));
    const next = typeof body.next_before === "string" && body.next_before ? { b: body.next_before, ...(unreadOnly ? { u: true } : {}), l: limit } : null;
    // How many are unread in all, not on this page: "you have 3 unread" off
    // the first page of a longer list is the wrong number.
    const total = (count.body as { count?: unknown }).count;
    return toolOk({
      items,
      unread_count: typeof total === "number" ? total : items.filter((i) => i.unread).length,
      ...pageEnd("list_notifications", next),
    });
  },
};

export default tool;
