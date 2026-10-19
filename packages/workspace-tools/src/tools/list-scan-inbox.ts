import { countOf } from "@cobblr/platform-contract/plural";
import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { LIST_LIMIT_MAX, SCAN_INBOX_TEXT_PAGES, type ScanInboxRow, type SplitParentWords, type WorkspaceTool, summarizeScanItem } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_scan_inbox",
  description:
    "The ITEMS waiting unfiled in the scan inbox (barcodes, photos, notes, receipt lines); list_records cannot reach it. facet: needs_review (low confidence), waiting (over 2 days), unfiled (no destination), ready. One in full: get_scan_item.",

  mode: "read",
  paging: { by: "cursor" },
  params: {
    facet: z
      .enum(["all", "needs_review", "waiting", "unfiled", "ready"])
      .optional()
      .describe("Default: all pending"),
    q: z.string().optional().describe("Text filter over name, brand, barcode, notes and scan area"),
    limit: z.number().optional().describe(`Max items (default 20, max ${LIST_LIMIT_MAX})`),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, args) => {
    const cur = decodeCursor<{ f: string; l: number; c?: string; q?: string; o?: number }>("list_scan_inbox", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const st = cur.state;
    const facet = st?.f ?? (typeof args.facet === "string" && args.facet ? args.facet : "all");
    const limit = st?.l ?? Math.min(Number(args.limit) || 20, LIST_LIMIT_MAX);
    const q = st ? (st.q ?? "") : typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
    type InboxBody = {
      items?: ScanInboxRow[];
      batches?: Record<string, { label?: string | null }>;
      split_parents?: Record<string, SplitParentWords>;
      total?: number;
      partial?: string;
      next_cursor?: string | null;
    };
    const fetchPage = (n: number, cursor?: string) =>
      api.request(
        "GET",
        `/modules/core-scan/inbox?status=pending&triage=${encodeURIComponent(facet)}&limit=${n}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
    if (!q) {
      // The queue pages itself; its cursor rides inside ours.
      const res = await fetchPage(limit, st?.c);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the scan inbox"));
      const body = res.body as InboxBody;
      const items = (body.items ?? []).map((it) => summarizeScanItem(it, body.batches ?? {}, body.split_parents ?? {}));
      const next = typeof body.next_cursor === "string" && body.next_cursor ? { f: facet, l: limit, c: body.next_cursor } : null;
      return toolOk({
        items,
        // The QUEUE's total, not the page's length — answering "you have 6" off a
        // page of 6 out of 148 is the failure worth spending a field on.
        ...(typeof body.total === "number" ? { total_in_facet: body.total } : {}),
        ...(body.partial ? { partial: body.partial } : {}),
        ...pageEnd("list_scan_inbox", next),
      });
    }
    // A text filter reads the whole queue, not the first page of it: the
    // queue is ordered newest-first, not by relevance, so filtering one page
    // would answer "you don't have one" about an item further down.
    const all: ScanInboxRow[] = [];
    const batches: Record<string, { label?: string | null }> = {};
    const splitParents: Record<string, SplitParentWords> = {};
    let total: number | undefined;
    let cursor: string | undefined;
    let scannedAll = false;
    for (let round = 0; round < SCAN_INBOX_TEXT_PAGES; round++) {
      const res = await fetchPage(200, cursor);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the scan inbox"));
      const body = res.body as InboxBody;
      all.push(...(body.items ?? []));
      Object.assign(batches, body.batches ?? {});
      Object.assign(splitParents, body.split_parents ?? {});
      if (typeof body.total === "number") total = body.total;
      cursor = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : undefined;
      if (!cursor) {
        scannedAll = true;
        break;
      }
    }
    const matched = all.filter((it) =>
      [it.suggested_name, it.suggested_manufacturer, it.barcode_text, it.ai_notes, it.scan_area].some(
        (v) => typeof v === "string" && v.toLowerCase().includes(q),
      ),
    );
    const offset = st?.o ?? 0;
    const page = matched.slice(offset, offset + limit);
    const end = offset + page.length;
    return toolOk({
      items: page.map((it) => summarizeScanItem(it, batches, splitParents)),
      ...(typeof total === "number" ? { total_in_facet: total } : {}),
      matched: matched.length,
      ...(scannedAll ? {} : { note: `searched the newest ${countOf(all.length, "capture")} only; narrow the facet to reach older ones` }),
      ...pageEnd("list_scan_inbox", end < matched.length ? { f: facet, l: limit, q, o: end } : null),
    });
  },
};

export default tool;
