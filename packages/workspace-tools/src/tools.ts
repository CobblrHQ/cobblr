// THE workspace tool registry — every read/write an AI surface can perform on
// a workspace, defined ONCE. Consumers:
//   - the in-app Ask Cobb chat: read tools auto-run inside the agent loop
//     (through the caller's own permissions); WRITE tools become PROPOSALS the
//     user confirms — the chat never mutates inline;
//   - the MCP server: registers each tool 1:1 for an external Claude (writes
//     execute directly there — the external client owns its own confirm UX).
// Tool `mode` is what encodes that difference; descriptions are written for
// the MODEL (guidance on when to reach for each tool lives here, not in
// per-consumer prompts).
//
// Adding a capability = one entry here → both surfaces get it. Never add a
// tool to a consumer directly.

import { z } from "zod";
import { type WorkspaceApi, type ToolResult, toolOk, toolFail, apiErrorMessage } from "./api.js";
import {
  fetchKinds,
  resolveCreatePath,
  resolveUpdatePath,
  resolveDeletePath,
  summarizeKind,
} from "./kinds.js";

export type ToolMode = "read" | "write";

export interface WorkspaceTool {
  /** Bare name — consumers prefix as needed (MCP: `cobblr_<name>`). */
  name: string;
  description: string;
  mode: ToolMode;
  params: z.ZodRawShape;
  execute(api: WorkspaceApi, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Clamp big reads so a tool result stays prompt-sized. */
const LIST_LIMIT_MAX = 50;

export const WORKSPACE_TOOLS: WorkspaceTool[] = [
  {
    name: "list_record_kinds",
    description:
      "List every kind of record this workspace holds (its modules + user-built apps), with each kind's fields and whether records of it can be created/updated/deleted. Call this before creating or querying records of an unfamiliar kind.",
    mode: "read",
    params: {},
    execute: async (api) => {
      const kinds = await fetchKinds(api);
      return toolOk(
        kinds.map((k) => ({
          ...summarizeKind(k),
          can_create: resolveCreatePath(k.id, kinds) !== null,
        })),
      );
    },
  },
  {
    name: "list_records",
    description:
      "List records of ONE kind, optionally filtered by a text query. Use this to see what the user actually has (their stock, their projects, their entries) BEFORE answering questions about their data.",
    mode: "read",
    params: {
      kind: z.string().describe("Entity kind id, e.g. inventory:part (see list_record_kinds)"),
      q: z.string().optional().describe("Text filter"),
      limit: z.number().optional().describe(`Max results (default 20, max ${LIST_LIMIT_MAX})`),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const limit = Math.min(Number(args.limit) || 20, LIST_LIMIT_MAX);
      const q = typeof args.q === "string" && args.q.trim() ? `&q=${encodeURIComponent(args.q.trim())}` : "";
      const res = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=${limit}${q}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, `couldn't list ${kind}`));
      // Honest truncation: a page exactly at the limit probably isn't the whole
      // set — say so, so the model never claims "you have 20 X" off a capped page.
      const body = res.body as { items?: unknown[] };
      if (Array.isArray(body.items) && body.items.length === limit) {
        return toolOk({
          ...body,
          note: `showing the first ${limit} — there may be more; narrow with q or raise limit (max ${LIST_LIMIT_MAX})`,
        });
      }
      return toolOk(res.body);
    },
  },
  {
    name: "get_record",
    description: "Fetch one record by kind + id (fields are projected by the caller's read permissions).",
    mode: "read",
    params: {
      kind: z.string().describe("Entity kind id"),
      id: z.string().describe("Record id"),
    },
    execute: async (api, args) => {
      const res = await api.request(
        "GET",
        `/entities/${encodeURIComponent(String(args.kind))}/${encodeURIComponent(String(args.id))}`,
      );
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "record not found"));
      return toolOk(res.body);
    },
  },
  {
    name: "search_records",
    description:
      "Search ACROSS every kind at once by text. Use when you don't know which kind holds the thing (\"citron\" might be a yarn, a part, or a note). For one known kind, prefer list_records with q.",
    mode: "read",
    params: {
      q: z.string().describe("Search text"),
      kinds: z.string().optional().describe("Comma-separated kind ids to restrict to"),
    },
    execute: async (api, args) => {
      const q = String(args.q ?? "").trim();
      if (!q) return toolFail("q is required");
      const kinds =
        typeof args.kinds === "string" && args.kinds.trim()
          ? `&kinds=${encodeURIComponent(args.kinds.trim())}`
          : "";
      const res = await api.request("GET", `/modules/core-search/search?q=${encodeURIComponent(q)}${kinds}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "search failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "list_related",
    description:
      "List the records LINKED to one record (its pairings) — which project a part belongs to, what's stored in a location, what a build consumed. Returns each link's relationship kind, direction, and the other record's kind + id (fetch it with get_record). Call with just kind + id first to discover what relationships exist.",
    mode: "read",
    params: {
      kind: z.string().describe("The record's entity kind id"),
      id: z.string().describe("The record's id"),
      relationship: z.string().optional().describe("Only links of this relationship kind"),
      direction: z
        .enum(["out", "in", "both"])
        .optional()
        .describe("out = links this record points at, in = links pointing at it (default both)"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const id = String(args.id ?? "");
      if (!kind || !id) return toolFail("kind and id are required");
      const rel =
        typeof args.relationship === "string" && args.relationship.trim()
          ? `&relationship_kind=${encodeURIComponent(args.relationship.trim())}`
          : "";
      const dir = args.direction === "out" || args.direction === "in" ? args.direction : "both";
      type PairingRow = {
        id: string;
        source_kind: string;
        source_id: string;
        target_kind: string;
        target_id: string;
        relationship_kind: string;
        notes?: string | null;
      };
      const fetchSide = async (side: "out" | "in") => {
        const who = side === "out" ? "source" : "target";
        const res = await api.request(
          "GET",
          `/pairings?${who}_kind=${encodeURIComponent(kind)}&${who}_id=${encodeURIComponent(id)}${rel}`,
        );
        if (res.status >= 400) throw new Error(apiErrorMessage(res, "couldn't list pairings"));
        return ((res.body.items as PairingRow[] | undefined) ?? []).map((p) => ({
          relationship: p.relationship_kind,
          direction: side,
          kind: side === "out" ? p.target_kind : p.source_kind,
          id: side === "out" ? p.target_id : p.source_id,
          ...(p.notes ? { notes: p.notes } : {}),
          pairing_id: p.id,
        }));
      };
      try {
        const items = (
          await Promise.all([
            dir !== "in" ? fetchSide("out") : Promise.resolve([]),
            dir !== "out" ? fetchSide("in") : Promise.resolve([]),
          ])
        ).flat();
        return toolOk({ items });
      } catch (err) {
        return toolFail(err instanceof Error ? err.message : "couldn't list pairings");
      }
    },
  },
  {
    name: "list_actions",
    description:
      "Discover the operations (actions) this workspace can run on existing records — adjust stock, mark a task done, build one of something. Optionally filter to one kind. Use invoke_action to run one.",
    mode: "read",
    params: {
      kind: z.string().optional().describe("Only actions applicable to this entity kind id"),
    },
    execute: async (api, args) => {
      const res = await api.request("GET", "/registered-actions");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list actions"));
      const items = (res.body.items as Array<{ matched_kinds?: string[] }> | undefined) ?? [];
      const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : null;
      return toolOk(kind ? items.filter((a) => (a.matched_kinds ?? []).includes(kind)) : items);
    },
  },
  {
    name: "get_putaway_plan",
    description:
      "The user's live put-away situation: how many scanned items still have no home, and the CURRENT organize plan (groups, destinations, evidence, unresolved items). Use this whenever the user talks about putting things away, organizing scanned items, bins, or 'the plan' — it is always fresher than anything pasted into chat. To help further, create core-locations:location records for places they describe (with their confirmation); the plan routes to real locations by evidence.",
    mode: "read",
    params: {},
    execute: async (api) => {
      const [stats, latest] = await Promise.all([
        api.request("GET", "/modules/core-scan/inbox/stats"),
        api.request("GET", "/modules/core-scan/organize/plan/latest"),
      ]);
      if (stats.status >= 400) return toolFail(apiErrorMessage(stats, "couldn't read scan stats"));
      const planBody = (latest.body as { plan?: Record<string, unknown> | null }).plan ?? null;
      const groups = Array.isArray((planBody as { groups?: unknown[] } | null)?.groups)
        ? ((planBody as { groups: Array<Record<string, unknown>> }).groups ?? [])
        : [];
      const names = ((planBody as { item_names?: Record<string, string> } | null)?.item_names ??
        {}) as Record<string, string>;
      return toolOk({
        backlog: stats.body,
        plan: planBody
          ? {
              plan_id: (planBody as { plan_id?: unknown }).plan_id,
              hinted: !!(planBody as { draft_hinted?: unknown }).draft_hinted,
              applied_group_ids: (planBody as { applied_group_ids?: unknown }).applied_group_ids,
              groups: groups.slice(0, 20).map((g) => ({
                label: g.label,
                rationale: g.rationale,
                destination: g.destination,
                ai_guess: g.ai_guess ?? false,
                items: (Array.isArray(g.item_ids) ? (g.item_ids as string[]) : [])
                  .slice(0, 15)
                  .map((id) => names[id] ?? id),
              })),
            }
          : null,
        note: planBody
          ? "This is the standing plan the user sees. After you create/rename locations for them, call replan_putaway once — the open plan refreshes itself."
          : "No current plan — the user can open 'Put them away' to make one.",
      });
    },
  },
  {
    name: "replan_putaway",
    description:
      "Recompute the user's put-away plan against the CURRENT workspace. Non-destructive: it only refreshes the proposal (nothing files, the user still accepts groups). Call this ONCE after you finish creating or renaming locations for them — the open plan updates automatically. Optionally pass a hint distilling what you learned in this conversation (e.g. 'the user is organizing camping gear; the hallway closet holds electronics').",
    mode: "read",
    params: {
      hint: z
        .string()
        .optional()
        .describe("Optional ground truth for the planner, distilled from the conversation (max 500 chars)"),
    },
    execute: async (api, args) => {
      const hint = typeof args.hint === "string" && args.hint.trim() ? args.hint.trim().slice(0, 500) : undefined;
      const res = await api.request("POST", "/modules/core-scan/organize/plan", {
        scope: "pending",
        fresh: true,
        ...(hint ? { hint } : {}),
      });
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't re-plan"));
      const body = res.body as {
        plan_id?: unknown;
        groups?: Array<Record<string, unknown>>;
        item_names?: Record<string, string>;
      };
      const names = body.item_names ?? {};
      return toolOk({
        plan_id: body.plan_id,
        groups: (body.groups ?? []).slice(0, 20).map((g) => ({
          label: g.label,
          destination: g.destination,
          items: (Array.isArray(g.item_ids) ? (g.item_ids as string[]) : [])
            .slice(0, 15)
            .map((id) => names[id] ?? id),
        })),
        note: "The user's open plan refreshes itself — summarize what changed instead of pasting the whole plan.",
      });
    },
  },
  {
    name: "create_record",
    description:
      "Create ONE new record. Use the kind's EXACT field names from list_record_kinds (e.g. knowledge entries want \"title\", parts want \"name\"). Only kinds with can_create are accepted.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_create true"),
      fields: z.record(z.unknown()).describe("The record's fields, using the kind's exact field names"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveCreatePath(kind, kinds);
      if (!path) return toolFail(`records of "${kind}" can't be created this way (no create route declared)`);
      const res = await api.request("POST", `/${path}`, args.fields ?? {});
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "create failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "update_record",
    description:
      "Update fields on ONE existing record (partial update — only the fields you pass change). Only kinds with can_update are accepted.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_update true"),
      id: z.string().describe("Record id"),
      fields: z.record(z.unknown()).describe("The fields to change, using the kind's exact field names"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveUpdatePath(kind, String(args.id ?? ""), kinds);
      if (!path) return toolFail(`records of "${kind}" can't be updated this way (no update route declared)`);
      const res = await api.request("PATCH", `/${path}`, args.fields ?? {});
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "update failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "delete_record",
    description:
      "Delete ONE record. Only kinds with can_delete are accepted. Destructive — double-check you have the right record (get_record) before deleting.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_delete true"),
      id: z.string().describe("Record id"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveDeletePath(kind, String(args.id ?? ""), kinds);
      if (!path) return toolFail(`records of "${kind}" can't be deleted this way (no delete route declared)`);
      const res = await api.request("DELETE", `/${path}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "delete failed"));
      return toolOk(res.status === 204 ? { deleted: true } : res.body);
    },
  },
  {
    name: "invoke_action",
    description:
      "Run a registered action on one existing record (see list_actions for what's available and which kinds each applies to). This is how module operations happen: adjust stock, mark done, build one, print a label…",
    mode: "write",
    params: {
      action_id: z.string().describe("Action id, e.g. inventory:adjust-stock"),
      entity_kind: z.string().describe("The record's kind id"),
      entity_id: z.string().describe("The record's id"),
      args: z.record(z.unknown()).optional().describe("Action arguments (see the action's args schema from list_actions)"),
    },
    execute: async (api, args) => {
      const res = await api.request("POST", "/actions/invoke", {
        actionId: String(args.action_id ?? ""),
        entityKind: String(args.entity_kind ?? ""),
        entityId: String(args.entity_id ?? ""),
        args: (args.args as Record<string, unknown> | undefined) ?? undefined,
      });
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "action failed"));
      return toolOk(res.body);
    },
  },
];

export function getTool(name: string): WorkspaceTool | undefined {
  return WORKSPACE_TOOLS.find((t) => t.name === name);
}

export const READ_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "read");
export const WRITE_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "write");
