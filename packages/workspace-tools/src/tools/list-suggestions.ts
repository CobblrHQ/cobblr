import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_suggestions",
  description:
    "Edits and additions people you share with suggested, awaiting a decision, by record and person. Decide via invoke_action: platform:accept-suggestions, reject-suggestions, take-additions, leave-additions.",
  mode: "read",
  paging: { by: "one-call", why: "what waits for one person's decision, a review queue that is short by nature (capped at 500 by the route)" },
  params: {
    from: z.string().optional().describe("A person's name"),
    kind: z.string().optional().describe("A record's kind, with id"),
    id: z.string().optional(),
  },
  execute: async (api, args) => {
    const kind = typeof args.kind === "string" ? args.kind.trim() : "";
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const res = await api.request("GET", `/suggestions${kind && id ? `?${new URLSearchParams({ kind, id }).toString()}` : ""}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the suggested edits"));
    const body = res.body as {
      items?: Array<{ id: string; entity_kind: string; entity_id: string; title: string | null; label: string; was: string | null; now: string | null; yours: string | null; status: string; by_name: string | null; still_shared?: boolean }>;
      additions?: Array<{ id: string; entity_kind: string; title: string; by_name: string | null }>;
    };
    const from = typeof args.from === "string" ? args.from.trim().toLowerCase() : "";
    const byWho = (n: string | null) => !from || String(n ?? "").toLowerCase().includes(from);
    // One entry per record and person, the way the review page groups them,
    // so "accept Vince's on the CR-10" can name exactly that group.
    const groups = new Map<string, { kind: string; id: string; title: string | null; from: string | null; edits: Array<Record<string, unknown>> }>();
    for (const e of (body.items ?? []).filter((x) => byWho(x.by_name))) {
      const key = `${e.entity_kind}|${e.entity_id}|${e.by_name ?? ""}`;
      const g = groups.get(key) ?? { kind: e.entity_kind, id: e.entity_id, title: e.title, from: e.by_name, edits: [] };
      g.edits.push({
        id: e.id,
        field: e.label,
        suggested: e.now,
        was: e.was,
        ...(e.status === "conflict" ? { you_since_changed_it_to: e.yours } : {}),
        ...(e.still_shared === false ? { no_longer_shared: true } : {}),
      });
      groups.set(key, g);
    }
    const additions = (body.additions ?? []).filter((a) => byWho(a.by_name)).map((a) => ({ id: a.id, kind: a.entity_kind, title: a.title, from: a.by_name }));
    if (!groups.size && !additions.length) return toolOk({ records: [], additions: [], note: from ? `Nothing from ${args.from} is waiting.` : "No suggested edits or additions are waiting." });
    return toolOk({ records: [...groups.values()], additions });
  },
};

export default tool;
