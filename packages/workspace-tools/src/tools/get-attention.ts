import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type AttentionRow, type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_attention",
  description:
    "What needs the user now, the dashboard's 'needs you' feed: low stock, dates overdue or due within 30 days, captures to file, suggested edits. Call it FIRST on open-ended questions (\"what should I do today?\", \"anything need me?\").",
  mode: "read",
  paging: { by: "one-call", why: "the dashboard needs-you feed: one row per kind of thing with its count and a few examples; the count is the whole answer" },
  params: {},
  execute: async (api) => {
    const res = await api.request("GET", "/attention");
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read what needs attention"));
    // Each example is the RECORD where the feed knows one (kind, id, its
    // name, the feed's detail beside it), so an answer built from this can
    // name it as something to open; the reply's names are matched against
    // the records the turn read, and a bare title is not a record. Where the
    // feed names no record (a capture, a printer) the title stands alone.
    const rows = ((res.body as { items?: AttentionRow[] }).items ?? []).map((r) => ({
      kind: r.kind,
      what: r.label,
      count: r.count,
      examples: (r.entries?.length
        ? r.entries.map((e) => (e.record ? { kind: e.record.kind, id: e.record.id, title: e.record.name, detail: e.title } : e.title))
        : (r.sample ?? [])
      ).slice(0, 8),
    }));
    if (rows.length === 0) return toolOk({ items: [], note: "Nothing needs them right now." });
    return toolOk({ items: rows });
  },
};

export default tool;
