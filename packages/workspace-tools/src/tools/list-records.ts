import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { explainRecords } from "../field-meanings.js";
import { fetchKinds } from "../kinds.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { LIST_LIMIT_MAX, LIST_Q_MEANS, type WorkspaceTool, labelMatches, listRefusal, pageWithTruth, scanByText, severalMatch, splitContains } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_records",
  description:
    "List one kind before answering what the person has. Filter by text or secret presence.",
  mode: "read",
  paging: { by: "cursor" },
  params: {
    kind: z.string().describe("Entity kind, e.g. inventory:part (list_record_kinds)"),
    q: z.string().optional().describe(LIST_Q_MEANS),
    presence: z.record(z.enum(["empty", "has_value"])).optional().describe("Secret field keys: empty or has_value. Never values."),
    contains: z.record(z.string()).optional().describe("Text field → words it contains; lead with - for does not."),
    group_by: z.union([z.string(), z.array(z.object({ field: z.string(), bucket: z.enum(["month", "quarter", "year"]).optional() })).max(2)]).optional().describe("Up to two fields: full counts, currency totals, a page per group."),
    group_offset: z.number().int().min(0).optional().describe("Groups to skip."),
    group_keys: z.array(z.string().nullable()).optional().describe("A group's keys from grouping: reads its page."),
    offset: z.number().int().min(0).optional().describe("With group_keys, skip this many in the group."),
    limit: z.number().optional().describe(`Max results (default 20, max ${LIST_LIMIT_MAX})`),
    include_retired: z.boolean().optional().describe("Include archived records, for old things."),
    lent_out: z.boolean().optional().describe("Only things lent out now: who has each, when due back."),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, args) => {
    // Lent out is a loan on the record, not a field (record-loans.md): one
    // read answers it for the kind, whole.
    if (args.lent_out === true) {
      const lent = await api.request("GET", `/loans?kind=${encodeURIComponent(String(args.kind))}`);
      if (lent.status >= 400) return toolFail(apiErrorMessage(lent, "couldn't list what is lent out"));
      const items = (lent.body?.items as unknown[] | undefined) ?? [];
      return toolOk({ items, shown: items.length, total: items.length, partial: false });
    }
    // The cursor carries the query it was made for, so the next page is the
    // next page of THAT list even if a later call words its arguments
    // differently. `o` is the position; `s` marks the any-field scan.
    if (args.group_by) {
      const qs = new URLSearchParams({ group_by: typeof args.group_by === "string" ? args.group_by : JSON.stringify(args.group_by), limit: String(Math.min(Number(args.limit) || 20, 50)), group_offset: String(args.group_offset ?? 0), offset: String(args.offset ?? 0) });
      if (args.q) qs.set("q", String(args.q));
      if (args.group_keys) qs.set("group_keys", JSON.stringify(args.group_keys));
      if (args.include_retired) qs.set("include_retired", "1");
      for (const [field, value] of Object.entries((args.presence ?? {}) as Record<string, string>)) qs.set(`presence[${field}]`, value);
      const text = splitContains(args.contains);
      for (const [field, value] of Object.entries(text.contains)) qs.set(`contains[${field}]`, value);
      for (const [field, value] of Object.entries(text.notContains)) qs.set(`not_contains[${field}]`, value);
      const grouped = await api.request("GET", `/entities/${encodeURIComponent(String(args.kind))}?${qs}`);
      if (grouped.status >= 400) return toolFail(apiErrorMessage(grouped, "Couldn't group this collection."));
      const refusedGroup = listRefusal(grouped.body, String(args.kind));
      return refusedGroup ? toolFail(refusedGroup) : toolOk(grouped.body);
    }
    const cur = decodeCursor<{ k: string; o: number; q?: string; r?: boolean; s?: boolean; p?: Record<string, "empty" | "has_value">; c?: Record<string, string>; n?: Record<string, string> }>("list_records", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const st = cur.state;
    const kind = st?.k ?? String(args.kind ?? "");
    if (st && typeof args.kind === "string" && args.kind && args.kind !== st.k) {
      return toolFail(`that cursor is for ${st.k}, not ${args.kind}. Leave cursor out to start ${args.kind} from the top.`);
    }
    const limit = Math.min(Number(args.limit) || 20, LIST_LIMIT_MAX);
    const qText = st ? (st.q ?? "") : typeof args.q === "string" ? args.q.trim() : "";
    const includeRetired = st ? st.r === true : args.include_retired === true;
    const offset = st?.o ?? 0;
    const presence = st ? st.p ?? {} : (args.presence ?? {}) as Record<string, "empty" | "has_value">;
    // What a text field contains (#6896), carried in the cursor like presence.
    const asked = splitContains(args.contains);
    const contains = st ? st.c ?? {} : asked.contains;
    const notContains = st ? st.n ?? {} : asked.notContains;
    const presenceQuery = new URLSearchParams();
    for (const [field, value] of Object.entries(presence)) presenceQuery.set(`presence[${field}]`, value);
    for (const [field, value] of Object.entries(contains)) presenceQuery.set(`contains[${field}]`, value);
    for (const [field, value] of Object.entries(notContains)) presenceQuery.set(`not_contains[${field}]`, value);
    const state = (o: number, s?: boolean) => ({ k: kind, o, ...(Object.keys(presence).length ? { p: presence } : {}), ...(Object.keys(contains).length ? { c: contains } : {}), ...(Object.keys(notContains).length ? { n: notContains } : {}), ...(qText ? { q: qText } : {}), ...(includeRetired ? { r: true } : {}), ...(s ? { s: true } : {}) });
    const kinds = () => fetchKinds(api).catch(() => []);
    if (!st?.s) {
      const q = qText ? `&q=${encodeURIComponent(qText)}` : "";
      const retired = includeRetired ? "&include_retired=1" : "";
      const res = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=${limit}&offset=${offset}${q}${retired}${presenceQuery.size ? "&" + presenceQuery : ""}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, `couldn't list ${kind}`));
      const refused = listRefusal(res.body, kind);
      if (refused) return toolFail(refused);
      const page = pageWithTruth(res.body, limit, offset) as { items?: unknown[]; total?: number };
      const shown = Array.isArray(page.items) ? page.items.length : 0;
      if (presenceQuery.size || !(qText && offset === 0 && shown === 0)) {
        const end = offset + shown;
        const more = typeof page.total === "number" ? end < page.total : shown === limit;
        const shownPage = qText && Array.isArray(page.items) ? { ...page, items: labelMatches(page.items, qText) } : page;
        // A filter the collection could not run is said, never answered as
        // if it had run: these records are NOT narrowed by it.
        const unrun = Array.isArray((res.body as { unapplied?: unknown[] })?.unapplied) ? ((res.body as { unapplied: Array<{ col: string; op: string; value?: unknown }> }).unapplied) : [];
        return toolOk({
          ...(explainRecords(shownPage, await kinds()) as Record<string, unknown>),
          ...(qText && Array.isArray(page.items) ? severalMatch(page.items, qText) : {}),
          ...(unrun.length ? { not_filtered_by: unrun.map((p) => `${p.col} ${p.op.replace("_", " ")}${p.value === undefined ? "" : ` "${String(p.value)}"`}: this collection cannot filter that way, so these records are not narrowed by it`) } : {}),
          ...pageEnd("list_records", more ? state(end) : null),
        });
      }
    }
    // The kind's own search matched nothing by name. Before the model tells
    // the user "you have none", look at every text field ourselves.
    const scan = await scanByText(api, kind, qText, limit, { includeRetired }, st?.s ? offset : 0);
    if (!scan) return toolOk({ ...(explainRecords({ shown: 0, total: 0, partial: false, items: [] }, await kinds()) as Record<string, unknown>), ...pageEnd("list_records", null) });
    const scanned = Array.isArray(scan.body.items) ? { ...scan.body, items: labelMatches(scan.body.items as unknown[], qText) } : scan.body;
    return toolOk({
      ...(explainRecords(scanned, await kinds()) as Record<string, unknown>),
      ...(Array.isArray(scan.body.items) ? severalMatch(scan.body.items as unknown[], qText) : {}),
      ...pageEnd("list_records", scan.next === null ? null : state(scan.next, true)),
    });
  },
};

export default tool;
