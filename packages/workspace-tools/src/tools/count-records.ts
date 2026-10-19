import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { fetchKinds } from "../kinds.js";
import { COUNT_SCAN_MAX, type WorkspaceTool, fieldValue, listRefusal, recordMatchesText, unitsCounted, walkKind } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "count_records",
  description:
    "Count every record of one kind exactly, optionally group_by a field. For totals or existence; units counts the things represented (printers).",
  mode: "read",
  paging: { by: "one-call", why: "counts in code over every record (walks the kind itself); returns numbers, not rows" },
  params: {
    kind: z.string().describe("Entity kind id, e.g. inventory:part (see list_record_kinds)"),
    group_by: z.string().optional().describe("Field key to group by (title, or any field key from the kind's fields)"),
    q: z.string().optional().describe("Text filter, matched against EVERY text field of each record (name, brand, notes, custom fields), case-insensitive"),
    include_retired: z.boolean().optional().describe("Also count archived/retired records (off by default)"),
  },
  execute: async (api, args) => {
    const kind = String(args.kind ?? "");
    const groupBy = typeof args.group_by === "string" ? args.group_by.trim() : "";
    const qText = typeof args.q === "string" ? args.q.trim() : "";
    const countField = (await fetchKinds(api).catch(() => [])).find((k) => k.id === kind)?.count_field ?? null;
    // "How many" with nothing to filter or group is the kind's own COUNT,
    // asked in one call: walking the rows reached a 5000-row cap and said
    // "5000, incomplete" for a count the database answers exactly (#4789).
    // The rows are still walked when units are summed, and only reported
    // when every one of them was read.
    if (!qText && !groupBy) {
      const retired = args.include_retired === true ? "&include_retired=1" : "";
      const one = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=1${retired}`);
      if (one.status >= 400) return toolFail(apiErrorMessage(one, `couldn't count ${kind}`));
      const refusedCount = listRefusal(one.body, kind);
      if (refusedCount) return toolFail(refusedCount);
      const counted = (one.body as { total?: unknown }).total;
      if (typeof counted === "number") {
        let unitsPart = {};
        if (countField && counted > 0 && counted <= COUNT_SCAN_MAX) {
          const walkedUnits = await walkKind(api, kind, { includeRetired: args.include_retired === true });
          const u = walkedUnits.ok && walkedUnits.complete ? unitsCounted(walkedUnits.items, countField) : null;
          if (u !== null && u !== counted) unitsPart = { units: u, units_means: `how many things these records stand for (the sum of ${countField}); total is how many records` };
        }
        return toolOk({ kind, total: counted, ...unitsPart, scanned: counted, complete: true, counted_by: "the database" });
      }
    }
    // The text filter is applied HERE, over every field of every record, not
    // by the kind's own search (which may look at the name only).
    const walked = await walkKind(api, kind, { includeRetired: args.include_retired === true, maxRecords: Infinity });
    if (!walked.ok) return toolFail(apiErrorMessage(walked.res, `couldn't count ${kind}`));
    const all = qText ? walked.items.filter((r) => recordMatchesText(r, qText)) : walked.items;
    const total = qText ? all.length : walked.total;
    const scanned = walked.items.length;
    const complete = walked.complete;
    const unitsOf = (recs: Array<Record<string, unknown>>) => (countField ? unitsCounted(recs, countField) : null);
    const units = unitsOf(all);
    const unitsPart = units !== null && units !== total ? { units, units_means: `how many things these records stand for (the sum of ${countField}); total is how many records` } : {};
    if (!groupBy) return toolOk({ kind, ...(qText ? { q: qText, matched_by: "any text field" } : {}), total, ...unitsPart, scanned, complete });
    const counts = new Map<string, { value: string; count: number; records: Array<Record<string, unknown>> }>();
    for (const rec of all) {
      const raw = fieldValue(rec, groupBy);
      const value = raw === undefined || raw === null || raw === "" ? "(blank)" : String(raw);
      const key = value.toLowerCase();
      const hit = counts.get(key);
      if (hit) {
        hit.count += 1;
        hit.records.push(rec);
      } else counts.set(key, { value, count: 1, records: [rec] });
    }
    const groups = [...counts.values()]
      .map(({ value, count, records }) => {
        const u = unitsOf(records);
        return { value, count, ...(u !== null && u !== count ? { units: u } : {}) };
      })
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return toolOk({
      kind,
      group_by: groupBy,
      ...(qText ? { q: qText, matched_by: "any text field" } : {}),
      total,
      ...unitsPart,
      scanned,
      complete,
      groups,
      ...(groups.length === 1 && groups[0]?.value === "(blank)"
        ? { note: `no record has a value for "${groupBy}"; check the field key with list_record_kinds` }
        : {}),
    });
  },
};

export default tool;
