import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { explainRecords } from "../field-meanings.js";
import { fetchKinds } from "../kinds.js";
import { CURSOR_PARAM, decodeCursor, pageEnd } from "../paging.js";
import { SEARCH_FALLBACK_PAGES, SEARCH_PER_KIND, type WorkspaceTool, noneFound, recordMatchesText, severalMatch, significantWords } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "search_records",
  description:
    "Search all kinds by text when the kind is unknown. For one known kind, use list_records with q.",
  mode: "read",
  paging: { by: "cursor" },
  params: {
    q: z.string().describe("Search text"),
    kinds: z.string().optional().describe("Comma-separated kind ids to restrict to"),
    cursor: CURSOR_PARAM,
  },
  execute: async (api, args) => {
    // `w`: the one word a multiword search fell back to, carried so the
    // next page goes on through that word's results (#7147).
    const cur = decodeCursor<{ q: string; k?: string; o: number; w?: string }>("search_records", args.cursor);
    if (!cur.ok) return toolFail(cur.error);
    const q = cur.state?.q ?? String(args.q ?? "").trim();
    if (!q) return toolFail("q is required");
    const kindList = cur.state ? (cur.state.k ?? "") : typeof args.kinds === "string" ? args.kinds.trim() : "";
    const offset = cur.state?.o ?? 0;
    const perKind = SEARCH_PER_KIND;
    const kinds = kindList ? `&kinds=${encodeURIComponent(kindList)}` : "";
    const words = significantWords(q);
    // The routes match a query as one phrase. When the phrase finds nothing
    // and it has two or more words, ask again by its longest word and keep
    // only what holds EVERY word, so "my PLA offcuts" finds the offcuts and
    // not the spool (#4038). That word's results page like any search, and
    // a page of them can hold none of the others: the pages are followed
    // (a few at a time) and where they stopped goes in the cursor, so a
    // match on a later page is never cut off behind "no more" (#7147).
    const byEveryWord = async (word: string, from: number) => {
      let at = from;
      let every: unknown[] = [];
      let wide: Record<string, unknown> = {};
      let more = false;
      for (let pages = 0; pages < SEARCH_FALLBACK_PAGES; pages++) {
        const again = await api.request(
          "GET",
          `/modules/core-search/search?q=${encodeURIComponent(word)}${kinds}&per_kind=${perKind}&offset=${at}`,
        );
        if (again.status >= 400) return toolFail(apiErrorMessage(again, "search failed"));
        const { has_more: h, ...rest } = again.body as Record<string, unknown>;
        wide = rest;
        more = h === true;
        at += perKind;
        every = [...every, ...(Array.isArray(rest.items) ? (rest.items as unknown[]) : []).filter((it) => recordMatchesText(it, q))];
        if (every.length || !more) break;
      }
      return toolOk({
        ...(explainRecords({ ...wide, q, items: every }, await fetchKinds(api).catch(() => [])) as Record<string, unknown>),
        matched_by: `every word of "${q}" (${words.join(", ")}); nothing held the words as one phrase`,
        ...(every.length === 0 && !more && from === 0 ? noneFound(wide, q) : {}),
        ...severalMatch(every, q),
        ...pageEnd("search_records", more ? { q, ...(kindList ? { k: kindList } : {}), o: at, w: word } : null),
      });
    };
    if (cur.state?.w) return byEveryWord(cur.state.w, offset);
    const res = await api.request(
      "GET",
      `/modules/core-search/search?q=${encodeURIComponent(q)}${kinds}&per_kind=${perKind}&offset=${offset}`,
    );
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "search failed"));
    const more = (res.body as { has_more?: unknown }).has_more === true;
    const { has_more: _h, ...body } = res.body as Record<string, unknown>;
    const found = Array.isArray(body.items) ? (body.items as unknown[]) : [];
    if (found.length === 0 && offset === 0 && words.length >= 2) {
      return byEveryWord([...words].sort((a, b) => b.length - a.length)[0]!, 0);
    }
    const none = found.length === 0 && offset === 0 ? noneFound(body, q) : {};
    return toolOk({
      ...(explainRecords(body, await fetchKinds(api).catch(() => [])) as Record<string, unknown>),
      ...none,
      ...severalMatch(found, q),
      ...pageEnd("search_records", more ? { q, ...(kindList ? { k: kindList } : {}), o: offset + perKind } : null),
    });
  },
};

export default tool;
