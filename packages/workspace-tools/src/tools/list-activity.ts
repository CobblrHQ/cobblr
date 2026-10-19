import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { type ActivityRow, type WorkspaceTool, nameFromDiff } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_activity",
  description:
    "History, newest first: who changed what, when. entity_kind and entity_id filter to one record; history_entry_id picks an edit for platform:restore-record-version.",

  mode: "read",
  paging: { by: "cursor" },
  params: {
    limit: z.number().optional().describe("Page size, at most 100"),
    actions: z
      .string()
      .optional()
      .describe("Comma-separated actions"),
    entity_type: z.string().optional().describe("Record type, e.g. part"),
    entity_kind: z.string().optional().describe("Record kind"),
    entity_id: z.string().optional().describe("Record id"),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, args) => {
    const cur = decodeCursor<{ b: string; a?: string; e?: string; k?: string; i?: string; l: number }>("list_activity", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const st = cur.state;
    const limit = st?.l ?? Math.min(Number(args.limit) || 25, 100);
    const actions = st ? (st.a ?? "") : typeof args.actions === "string" ? args.actions.trim() : "";
    const entityType = st ? (st.e ?? "") : typeof args.entity_type === "string" ? args.entity_type.trim() : "";
    const q = [`limit=${limit}`];
    if (actions) q.push(`actions=${encodeURIComponent(actions)}`);
    if (entityType) q.push(`entity_type=${encodeURIComponent(entityType)}`);
    const entityKind = st ? st.k : args.entity_kind;
    const entityId = st ? st.i : args.entity_id;
    if (entityKind && entityId) { q.push(`entity_kind=${encodeURIComponent(String(entityKind))}`, `entity_id=${encodeURIComponent(String(entityId))}`); }
    if (st) q.push(`before=${encodeURIComponent(st.b)}`);
    const res = await api.request("GET", `/activity?${q.join("&")}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the activity log"));
    const rows = (res.body as { items?: ActivityRow[] }).items ?? [];
    const last = rows[rows.length - 1];
    const next = rows.length === limit && last?.id != null
      ? { b: String(last.id), ...(actions ? { a: actions } : {}), ...(entityType ? { e: entityType } : {}), ...(entityKind && entityId ? { k: String(entityKind), i: String(entityId) } : {}), l: limit }
      : null;
    const items = rows.map((a) => ({
      summary: a.summary,
      subject: a.subject,
      hidden: a.hidden ?? false,
      history_entry_id: a.id,
      restorable: a.restorable ?? false,
      ...(a.said ? { changes: a.said } : {}),
      when: a.occurred_at,
      action: a.action,
      // The route resolves `title` from the live record ONLY when the diff
      // doesn't already carry a name — so a create, whose diff always does,
      // arrives with title null. Reading just `title` therefore reported every
      // creation as its bare type ("created vendor"), which is the exact
      // failure the route's own title-resolution exists to prevent.
      what: a.subject?.title ?? a.entity_title ?? a.title ?? nameFromDiff(a.diff) ?? "a record",
      kind: a.module_name ? `${a.module_name}:${a.entity_type}` : a.entity_type,
      id: a.entity_id,
      // "system" and "api_token" are as much a part of the answer as a person:
      // "who changed this" is often "a wire did" or "your own script did".
      by: a.actor?.display_name ?? a.actor?.email ?? (a.auth_method === "system" ? "the system" : null),
      ...(a.token?.name ? { via_token: a.token.name } : {}),
    }));
    return toolOk({ items, ...pageEnd("list_activity", next) });
  },
};

export default tool;
