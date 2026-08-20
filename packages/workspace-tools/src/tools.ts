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
  withKindsTitleField,
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

/** The dashboard's "needs you" rows (api/src/routes/attention.ts). */
interface AttentionRow {
  kind: string;
  label: string;
  count: number;
  sample?: string[];
  entries?: Array<{ id: string; title: string }>;
}

/** The record's name as the CHANGE recorded it. The activity route treats a
 *  diff that carries a name as already answering "which one", and only resolves
 *  a live title for the entries that don't — so both halves have to be read to
 *  name every entry. */
function nameFromDiff(diff: unknown): string | null {
  if (!diff || typeof diff !== "object") return null;
  const d = diff as Record<string, unknown>;
  for (const key of ["name", "title", "label"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** One activity-log entry, already enriched server-side with the actor's name
 *  and (where the diff doesn't carry one) the record's live title. */
interface ActivityRow {
  action: string;
  entity_type: string;
  entity_id: string;
  module_name?: string | null;
  occurred_at: string;
  title?: string | null;
  diff?: unknown;
  auth_method?: string;
  actor?: { display_name?: string | null; email?: string | null } | null;
  token?: { name?: string } | null;
}

interface NotificationRow {
  message: string;
  event_type: string;
  created_at: string;
  read_at?: string | null;
  link_url?: string | null;
}

interface MaintenanceRow {
  id: string;
  name: string;
  entity_module?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  scheduled_at?: string | null;
  performed_at?: string | null;
  recurrence_rule?: string | null;
  notes?: string | null;
}

interface CalendarRow {
  date: string;
  title: string;
  source: string;
  category?: string;
  entityModule?: string;
  entityType?: string;
  entityId?: string;
}

/** The workspace's own shape — one row type per area of get_workspace_setup. */
interface InstanceRow {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default?: boolean;
  item_count?: number | null;
}

interface ViewRow {
  name: string;
  entity_kind: string;
  view_type: string;
  is_default?: boolean;
  pinned?: boolean;
}

interface BindingRow {
  id: string;
  source_kind: string;
  action_id: string;
  trigger_type: string;
  trigger_event?: string | null;
  trigger_schedule?: string | null;
  enabled?: boolean;
}

interface AppRow {
  name: string;
  slug: string;
}

interface TemplateRow {
  name: string;
  target_kind: string;
  description?: string | null;
  defaults?: Record<string, unknown>;
}

interface UnitVocabularyRow {
  builtins?: Array<{ name: string; symbol: string }>;
  custom?: Array<{ name: string; symbol: string }>;
  display_mode?: string;
}

/** A scan-inbox row, as the core-scan list route returns it. Only the fields
 *  worth telling a model about — `needs_review` and `waiting_days` are derived
 *  server-side from the shared triage predicate, so the model is told the same
 *  thing the Scan page shows the user. */
interface ScanInboxRow {
  id?: string;
  suggested_name?: string | null;
  suggested_manufacturer?: string | null;
  barcode_text?: string | null;
  source_kind?: string | null;
  quantity?: number | null;
  ai_notes?: string | null;
  scan_area?: string | null;
  scan_batch_id?: string | null;
  needs_review?: boolean;
  waiting_days?: number | null;
  target_kind?: string | null;
  target_location_id?: string | null;
  target_container_id?: string | null;
  suggested_candidates?: unknown;
}

/** One queue row, flattened to what a person would say about it. Drops the
 *  identification internals (candidate arrays, scores, image ids) — a chat
 *  answer needs what it is, how long it has waited and what it still needs. */
function summarizeScanItem(
  it: ScanInboxRow,
  batches: Record<string, { label?: string | null }>,
): Record<string, unknown> {
  // Where it is headed: the route already chosen, else the matchmaker's top
  // candidate (what filing it would create, and under which category).
  const top = Array.isArray(it.suggested_candidates)
    ? (it.suggested_candidates as Array<{ kind?: string; label?: string; category?: string }>)[0]
    : null;
  const target = it.target_kind ?? top?.kind ?? null;
  const session = it.scan_batch_id ? batches[it.scan_batch_id]?.label : null;
  return {
    id: it.id,
    // An unidentified capture is the honest answer, not a blank name.
    name: it.suggested_name ?? "(not identified yet)",
    ...(it.suggested_manufacturer ? { brand: it.suggested_manufacturer } : {}),
    ...(top?.category ? { category: top.category } : {}),
    ...(it.quantity && it.quantity !== 1 ? { quantity: it.quantity } : {}),
    captured_as: it.source_kind ?? "scan",
    ...(it.barcode_text ? { barcode: it.barcode_text } : {}),
    ...(typeof it.waiting_days === "number" ? { waiting_days: it.waiting_days } : {}),
    ...(it.needs_review ? { needs_review: true } : {}),
    ...(it.ai_notes ? { notes: it.ai_notes } : {}),
    ...(target ? { would_become: target } : {}),
    has_destination: !!(it.target_location_id || it.target_container_id),
    ...(it.scan_area ? { scanned_in: it.scan_area } : {}),
    ...(session ? { session } : {}),
  };
}

// ─────────────────────── escort destinations (tier 1.5) ───────────────────
//
// The surfaces the assistant may WALK THE USER TO but never operate: each is a
// tier-1 "no door" surface (docs/design-decisions/platform-actions.md — the
// consent tiers), where a Confirm card cannot carry the decision's weight, so
// the page itself is the consent surface. The escort is inert by construction:
// navigation + prefilled form fields, and the page's own submit — under the
// page's own role checks, showing the full blast radius — is the only thing
// that mutates. Prefill params are only read by pages that opt in via
// usePrefill(); nothing ever auto-submits.
//
// This list IS the tier-1 catalogue. Adding a row here must not add a write
// path — if a surface deserves operating, it becomes an action (tier 2), not
// a bigger escort.

export interface EscortDestination {
  id: string;
  path: string;
  label: string;
  /** Prefill keys the destination's page reads (via usePrefill) — the contract
   *  between this registry and the page. Empty = navigation only. */
  prefill: Record<string, string>;
  /** Why this surface is escort-only — surfaced to the model so it can say so. */
  why: string;
}

export const ESCORT_DESTINATIONS: EscortDestination[] = [
  {
    id: "members",
    path: "/configuration/members",
    label: "Members & invites",
    prefill: {
      email: "email address to prefill on the invite form",
      role: "role to preselect: member, editor, admin or guest",
    },
    why: "who is in the workspace, and as what, is a human decision",
  },
  {
    id: "api-tokens",
    path: "/configuration/tokens",
    label: "API tokens",
    prefill: {},
    why: "credentials are never minted or revoked by the assistant",
  },
  {
    id: "backup",
    path: "/configuration/backup",
    label: "Backup & restore",
    prefill: {},
    why: "a restore replaces data wholesale; the page shows what a card cannot",
  },
  {
    id: "ai-config",
    path: "/configuration/ai",
    label: "AI providers",
    prefill: {},
    why: "the assistant does not configure its own reach or keys",
  },
  {
    id: "wires",
    path: "/wires",
    label: "Automations (wires)",
    prefill: {},
    why: "composing standing automation is consented in the composer, not a card",
  },
  {
    id: "fields",
    path: "/fields",
    label: "Fields & forms",
    prefill: {},
    why: "editing or deleting a field touches the data under it; adding one is the platform:add-field action",
  },
];

export const WORKSPACE_TOOLS: WorkspaceTool[] = [
  {
    name: "take_user_to",
    description:
      "ESCORT the user to a configuration screen you cannot operate yourself — inviting members, API tokens, backup & restore, AI providers, composing automations, editing fields. In the Cobblr app this MOVES their screen there (elsewhere, give them the path as a link) and can PREFILL the form (e.g. the invite email), but nothing is submitted: the user presses the page's own button. Use this when they ask for something on those surfaces instead of refusing dry — say why it needs their hand, then take them there. Destinations: " +
      ESCORT_DESTINATIONS.map((d) => `${d.id} (${d.why})`).join("; ") +
      ".",
    mode: "read",
    params: {
      destination: z
        .string()
        .describe(`One of: ${ESCORT_DESTINATIONS.map((d) => d.id).join(", ")}`),
      email: z.string().optional().describe("members only: email to prefill on the invite form"),
      role: z.string().optional().describe("members only: member, editor, admin or guest"),
    },
    execute: async (_api, args) => {
      const id = typeof args.destination === "string" ? args.destination.trim().toLowerCase() : "";
      const dest = ESCORT_DESTINATIONS.find((d) => d.id === id);
      if (!dest) {
        return toolFail(
          `no such destination — use one of: ${ESCORT_DESTINATIONS.map((d) => d.id).join(", ")}`,
        );
      }
      // Only the keys the destination DECLARES ride along; anything else is
      // dropped, so a page can trust that every prefill.* param it reads was
      // meant for it.
      const params = new URLSearchParams();
      for (const key of Object.keys(dest.prefill)) {
        const v = args[key];
        if (typeof v === "string" && v.trim()) params.set(`prefill.${key}`, v.trim());
      }
      const qs = params.toString();
      return toolOk({
        escort: { path: qs ? `${dest.path}?${qs}` : dest.path, label: dest.label },
        note:
          "The user's screen is moving there now (in-app). Nothing was submitted — tell them what to press to finish, and why this one is theirs to press.",
      });
    },
  },
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
      "List the records LINKED to one record (its pairings): which project a part belongs to, what's stored in a location, what a build consumed. Returns each link's relationship kind, direction, and the other record's kind + id (fetch it with get_record). Call with just kind + id first to discover what relationships exist.",
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
      "Discover the operations (actions) this workspace can run. Each item has a `scope`: an 'entity' action runs on a record (adjust stock, mark a task done, build one) and its matched_kinds lists which record kinds it applies to; a 'workspace' action is a config/admin operation that runs on the whole workspace (reorder locations, rename a label-code prefix, change a default) and is invoked WITHOUT a record. Each item also carries `args_schema`: the named arguments that action takes, which you pass as invoke_action's `args`, and `undoable`: whether running it by mistake can be put right inside the workspace. On a connection that cannot show a confirmation prompt, only the undoable ones will run; the rest refuse and say so, which is worth telling the user rather than claiming you have no way to act. Optionally filter to one entity kind; workspace actions are always included. Use invoke_action to run one.",
    mode: "read",
    params: {
      kind: z.string().optional().describe("Only entity actions applicable to this kind id (workspace actions still included)"),
    },
    execute: async (api, args) => {
      const res = await api.request("GET", "/registered-actions");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list actions"));
      const items =
        (res.body.items as
          | Array<{
              id?: string;
              label?: string;
              description?: string;
              module_name?: string;
              matched_kinds?: string[];
              scope?: string;
              args_schema?: Record<string, { label?: string; type?: string }> | null;
              undoable?: boolean;
              examples?: string[];
            }>
          | undefined) ?? [];
      const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : null;
      // When filtering by a record's kind, still surface workspace-level config
      // actions — they're not record-scoped but the user may want one from here.
      const picked = kind
        ? items.filter((a) => a.scope === "workspace" || (a.matched_kinds ?? []).includes(kind))
        : items;
      // Project to what a caller needs to actually RUN one. `args` is the
      // decisive field: an action listed without its arguments is an action
      // that cannot be invoked, and the honest-looking conclusion is "I have no
      // way to run this" — which is what happened with core-locations:reorder
      // and its `ids` (2026-08-19).
      return toolOk(
        picked.map((a) => ({
          id: a.id,
          label: a.label,
          description: a.description,
          // Which module it came from: dropped once in the projection below and
          // caught only by a test that pins it, so it stays named here.
          module_name: a.module_name,
          scope: a.scope ?? "entity",
          // Whether running it by mistake can be put right here. A connection
          // with no way to show a confirmation may run only the undoable ones,
          // so this is the difference between "I will do that" and a refusal
          // the user can act on.
          undoable: a.undoable === true,
          // How a person asks for it, so a sentence can be matched to an action
          // rather than guessed at from the id.
          ...(a.examples?.length ? { said_like: a.examples } : {}),
          ...(a.scope === "workspace" ? {} : { matched_kinds: a.matched_kinds ?? [] }),
          args: a.args_schema && Object.keys(a.args_schema).length
            ? Object.fromEntries(
                Object.entries(a.args_schema).map(([name, spec]) => {
                  const type = spec?.type ?? "text";
                  return [
                    name,
                    {
                      type,
                      ...(spec?.label ? { describes: spec.label } : {}),
                      // Spelling out the JSON shape for a list: "type: list"
                      // alone was read as "a comma-separated string" often
                      // enough to matter, and the order inside a list is
                      // frequently the whole point of the call.
                      ...(type === "list" ? { pass_as: 'a JSON array, in order — ["…", "…"]' } : {}),
                    },
                  ];
                }),
              )
            : undefined,
        })),
      );
    },
  },
  {
    name: "get_attention",
    description:
      "What needs the user RIGHT NOW: the same 'needs you' feed their dashboard shows — stock that has run low, dates that are overdue or coming up in the next 30 days, and captures still waiting to be filed. Derived from the workspace's own field semantics, so it covers every tracker they have, including ones they built themselves. Reach for this FIRST on any open-ended question about their situation (\"what should I do today?\", \"anything need me?\", \"am I behind on anything?\") — it is one call and it is what they are looking at.",
    mode: "read",
    params: {},
    execute: async (api) => {
      const res = await api.request("GET", "/attention");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read what needs attention"));
      const rows = ((res.body as { items?: AttentionRow[] }).items ?? []).map((r) => ({
        kind: r.kind,
        what: r.label,
        count: r.count,
        examples: (r.entries ?? []).slice(0, 8).map((e) => e.title).concat(r.sample ?? []).slice(0, 8),
      }));
      if (rows.length === 0) return toolOk({ items: [], note: "Nothing needs them right now." });
      return toolOk({ items: rows });
    },
  },
  {
    name: "list_activity",
    description:
      "The workspace's history — what actually happened, newest first: who created, updated or deleted what, and when. Use for any question about the PAST (\"what changed this week?\", \"who edited this part?\", \"did anything get deleted?\", \"what have I been doing?\"). Records answer what the user HAS; this answers what HAPPENED to it. Filter by entity_type to follow one kind of thing.",
    mode: "read",
    params: {
      limit: z.number().optional().describe("Max entries (default 25, max 100)"),
      actions: z
        .string()
        .optional()
        .describe("Comma-separated action filter, e.g. delete,update (omit for everything)"),
      entity_type: z.string().optional().describe("Only entries about this entity type, e.g. part"),
    },
    execute: async (api, args) => {
      const limit = Math.min(Number(args.limit) || 25, 100);
      const q = [`limit=${limit}`];
      if (typeof args.actions === "string" && args.actions.trim())
        q.push(`actions=${encodeURIComponent(args.actions.trim())}`);
      if (typeof args.entity_type === "string" && args.entity_type.trim())
        q.push(`entity_type=${encodeURIComponent(args.entity_type.trim())}`);
      const res = await api.request("GET", `/activity?${q.join("&")}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the activity log"));
      const items = ((res.body as { items?: ActivityRow[] }).items ?? []).map((a) => ({
        when: a.occurred_at,
        action: a.action,
        // The route resolves `title` from the live record ONLY when the diff
        // doesn't already carry a name — so a create, whose diff always does,
        // arrives with title null. Reading just `title` therefore reported every
        // creation as its bare type ("created vendor"), which is the exact
        // failure the route's own title-resolution exists to prevent.
        what: a.title ?? nameFromDiff(a.diff) ?? a.entity_type,
        kind: a.module_name ? `${a.module_name}:${a.entity_type}` : a.entity_type,
        id: a.entity_id,
        // "system" and "api_token" are as much a part of the answer as a person:
        // "who changed this" is often "a wire did" or "your own script did".
        by: a.actor?.display_name ?? a.actor?.email ?? (a.auth_method === "system" ? "the system" : null),
        ...(a.token?.name ? { via_token: a.token.name } : {}),
      }));
      return toolOk({ items });
    },
  },
  {
    name: "list_notifications",
    description:
      "The user's notifications in this workspace — what the system has been telling them (a job finished, stock ran out, something needs review), newest first. Use for \"what did I miss?\", \"anything new?\", \"what happened while I was away?\". Pass unread_only to see only what they have not read yet.",
    mode: "read",
    params: {
      unread_only: z.boolean().optional().describe("Only notifications they have not read"),
      limit: z.number().optional().describe("Max notifications (default 25, max 100)"),
    },
    execute: async (api, args) => {
      const limit = Math.min(Number(args.limit) || 25, 100);
      const unread = args.unread_only ? "&unread=1" : "";
      const res = await api.request("GET", `/notifications?limit=${limit}${unread}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read notifications"));
      const items = ((res.body as { items?: NotificationRow[] }).items ?? []).map((n) => ({
        when: n.created_at,
        message: n.message,
        about: n.event_type,
        unread: !n.read_at,
        ...(n.link_url ? { link: n.link_url } : {}),
      }));
      return toolOk({ items, unread_count: items.filter((i) => i.unread).length });
    },
  },
  {
    name: "list_maintenance",
    description:
      "Scheduled and completed maintenance across the workspace — services, inspections, filter changes, anything logged against a machine, vehicle, asset or tool. Use for \"what is due for service?\", \"when did I last change that?\", \"what maintenance is overdue?\". `due` narrows to work that is scheduled and not yet done; `history` to work already performed; `within_days` to what falls due inside a window.",
    mode: "read",
    params: {
      due: z.boolean().optional().describe("Only scheduled work not yet performed"),
      history: z.boolean().optional().describe("Only work already performed"),
      within_days: z.number().optional().describe("With due: only what falls due inside this many days"),
      entity_id: z.string().optional().describe("Only maintenance for this record"),
      limit: z.number().optional().describe(`Max entries (default 25, max ${LIST_LIMIT_MAX})`),
    },
    execute: async (api, args) => {
      const limit = Math.min(Number(args.limit) || 25, LIST_LIMIT_MAX);
      // Filter at the source: the route already understands scheduled-vs-history
      // and a due window, so a page of 25 is 25 of the RIGHT rows rather than 25
      // of everything, sifted here.
      const q: string[] = [`limit=${limit}`];
      if (args.due === true) q.push("kind=scheduled");
      else if (args.history === true) q.push("kind=history");
      const within = Number(args.within_days);
      if (args.due === true && Number.isFinite(within) && within > 0)
        q.push(`due_within_days=${Math.floor(within)}`);
      if (typeof args.entity_id === "string" && args.entity_id.trim())
        q.push(`entity_id=${encodeURIComponent(args.entity_id.trim())}`);
      const res = await api.request("GET", `/modules/core-maintenance/entries?${q.join("&")}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read maintenance"));
      const rows = ((res.body as { items?: MaintenanceRow[] }).items ?? []).map((e) => ({
        id: e.id,
        what: e.name,
        on: e.entity_type ? `${e.entity_module}:${e.entity_type}` : null,
        entity_id: e.entity_id,
        ...(e.scheduled_at ? { scheduled: e.scheduled_at } : {}),
        ...(e.performed_at ? { done: e.performed_at } : { outstanding: true }),
        ...(e.recurrence_rule ? { repeats: e.recurrence_rule } : {}),
        ...(e.notes ? { notes: e.notes } : {}),
      }));
      return toolOk({
        items: rows.slice(0, limit),
        total: rows.length,
        ...(rows.length > limit ? { note: `showing ${limit} of ${rows.length}` } : {}),
      });
    },
  },
  {
    name: "list_calendar",
    description:
      "What is coming up (or what was on) the workspace calendar in a date window — due dates, scheduled maintenance, recurring chores, project deadlines, anything the workspace puts on a date. Use for \"what's on this week?\", \"what's due before Friday?\", \"what did I have on last month?\". Dates are YYYY-MM-DD; the default window is the next 30 days.",
    mode: "read",
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
        ...(e.entityType ? { about: `${e.entityModule}:${e.entityType}`, entity_id: e.entityId } : {}),
      }));
      return toolOk({ window: { from, to }, items });
    },
  },
  {
    name: "list_scan_inbox",
    description:
      "List the actual ITEMS waiting in the scan inbox — captures (barcode scans, photos, notes, receipt lines) that have not been filed into a record yet. The scan inbox is NOT a record kind, so list_records cannot reach it: use THIS whenever the user asks what is in their inbox, what needs reviewing, what has been sitting there, or about a specific captured item. Each item says what it was identified as, how long it has waited, whether it still needs a human, and where it is headed. Filter with `facet`: needs_review (no clean name, low confidence, or a rate-limited lookup), waiting (sitting more than two days), unfiled (no destination yet), ready (has a destination and nothing left to ask).",
    mode: "read",
    params: {
      facet: z
        .enum(["all", "needs_review", "waiting", "unfiled", "ready"])
        .optional()
        .describe("Which slice of the queue (default: everything pending)"),
      q: z.string().optional().describe("Text filter over name, brand, barcode, notes and scan area"),
      limit: z.number().optional().describe(`Max items (default 20, max ${LIST_LIMIT_MAX})`),
    },
    execute: async (api, args) => {
      const facet = typeof args.facet === "string" && args.facet ? args.facet : "all";
      const limit = Math.min(Number(args.limit) || 20, LIST_LIMIT_MAX);
      const q = typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
      // A text filter reads wider than the page it returns: the queue is ordered
      // newest-first, not by relevance, so filtering only the first N rows would
      // answer "you don't have one" about an item sitting further down.
      const fetchLimit = q ? 200 : limit;
      const res = await api.request(
        "GET",
        `/modules/core-scan/inbox?status=pending&triage=${encodeURIComponent(facet)}&limit=${fetchLimit}`,
      );
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the scan inbox"));
      const body = res.body as {
        items?: ScanInboxRow[];
        batches?: Record<string, { label?: string | null }>;
        total?: number;
        partial?: string;
      };
      const all = body.items ?? [];
      const matched = q
        ? all.filter((it) =>
            [it.suggested_name, it.suggested_manufacturer, it.barcode_text, it.ai_notes, it.scan_area].some(
              (v) => typeof v === "string" && v.toLowerCase().includes(q),
            ),
          )
        : all;
      const items = matched.slice(0, limit).map((it) => summarizeScanItem(it, body.batches ?? {}));
      return toolOk({
        items,
        // The QUEUE's total, not the page's length — answering "you have 6" off a
        // page of 6 out of 148 is the failure worth spending a field on.
        ...(typeof body.total === "number" ? { total_in_facet: body.total } : {}),
        ...(q ? { matched: matched.length } : {}),
        ...(matched.length > items.length
          ? {
              note: `showing ${items.length} of ${matched.length} — narrow with q or raise limit (max ${LIST_LIMIT_MAX})`,
            }
          : {}),
        ...(body.partial ? { partial: body.partial } : {}),
      });
    },
  },
  {
    name: "get_workspace_setup",
    description:
      "How this workspace is SET UP, as opposed to what it holds: its instances (the separate lists one module runs, e.g. 3D Printers and CNC both from Machines), its saved views, its automations (wires: when X happens, do Y), the apps the user built, their entity templates, and their unit vocabulary. Use for \"how is my workspace set up?\", \"what automations do I have?\", \"why did that happen by itself?\", \"what views/apps/templates do I have?\", or before proposing a change to any of them. `part` picks one area; omit it for a summary of every area at once.",
    mode: "read",
    params: {
      part: z
        .enum(["all", "instances", "views", "automations", "apps", "templates", "units"])
        .optional()
        .describe("Which area of the setup (default: a summary of all of them)"),
    },
    execute: async (api, args) => {
      const part = typeof args.part === "string" && args.part ? args.part : "all";
      const want = (p: string) => part === "all" || part === p;
      // Each area is optional: a workspace that has not enabled a module 404s
      // that one, and the honest answer is "that area is not set up here" — not
      // a failed tool call that loses the six areas that DID answer.
      const grab = async <T>(path: string, pick: (body: Record<string, unknown>) => T): Promise<T | null> => {
        const res = await api.request("GET", path);
        if (res.status >= 400) return null;
        try {
          return pick(res.body);
        } catch {
          return null;
        }
      };
      const out: Record<string, unknown> = {};

      if (want("instances")) {
        const rows = await grab("/instances", (b) => (b.items as InstanceRow[] | undefined) ?? []);
        if (rows) {
          out.instances = rows.map((i) => ({
            name: i.display_name,
            instance: i.instance_name,
            from_module: i.module_name,
            ...(i.is_default ? { is_default: true } : {}),
            ...(typeof i.item_count === "number" ? { items: i.item_count } : {}),
            // The kind id is what every OTHER tool needs to act on this list.
            kind: `${i.instance_name}:item`,
          }));
        }
      }
      if (want("views")) {
        const rows = await grab("/modules/core-views/views", (b) => (b.items as ViewRow[] | undefined) ?? []);
        if (rows) {
          out.views = rows.map((v) => ({
            name: v.name,
            of: v.entity_kind,
            shown_as: v.view_type,
            ...(v.is_default ? { is_default: true } : {}),
            ...(v.pinned ? { pinned_to_dashboard: true } : {}),
          }));
        }
      }
      if (want("automations")) {
        const rows = await grab("/bindings", (b) => (b.items as BindingRow[] | undefined) ?? []);
        if (rows) {
          out.automations = rows.map((w) => ({
            does: w.action_id,
            on: w.source_kind,
            when:
              w.trigger_type === "schedule"
                ? `on a schedule (${w.trigger_schedule ?? "unspecified"})`
                : w.trigger_type === "event"
                  ? `the event ${w.trigger_event ?? "?"}`
                  : w.trigger_type,
            // A disabled wire explains a "why didn't that happen" as surely as an
            // enabled one explains a "why did that happen".
            ...(w.enabled === false ? { enabled: false } : {}),
            id: w.id,
          }));
        }
      }
      if (want("apps")) {
        const rows = await grab("/modules/core-apps/apps", (b) => (b.items as AppRow[] | undefined) ?? []);
        if (rows) out.apps = rows.map((a) => ({ name: a.name, slug: a.slug }));
      }
      if (want("templates")) {
        const rows = await grab(
          "/modules/core-templates/templates",
          (b) => (b.items as TemplateRow[] | undefined) ?? [],
        );
        if (rows) {
          out.templates = rows.map((t) => ({
            name: t.name,
            creates: t.target_kind,
            ...(t.description ? { description: t.description } : {}),
            prefills: Object.keys(t.defaults ?? {}),
          }));
        }
      }
      if (want("units")) {
        const vocab = await grab("/modules/core-units/units", (b) => b as unknown as UnitVocabularyRow);
        if (vocab) {
          out.units = {
            // Only the CUSTOM ones are a fact about this workspace; the builtins
            // are the same everywhere and would be noise in every answer.
            custom: (vocab.custom ?? []).map((u) => `${u.name} (${u.symbol})`),
            builtin_count: (vocab.builtins ?? []).length,
            ...(vocab.display_mode ? { display_mode: vocab.display_mode } : {}),
          };
        }
      }

      const areas = Object.keys(out);
      if (areas.length === 0) {
        return toolOk({
          note:
            part === "all"
              ? "None of these areas are set up in this workspace yet."
              : `The ${part} area is not available in this workspace (its module may not be enabled).`,
        });
      }
      return toolOk(out);
    },
  },
  {
    name: "get_putaway_plan",
    description:
      "The user's live put-away situation: how many scanned items still have no home, and the CURRENT organize plan (groups, destinations, evidence, unresolved items). Use this whenever the user talks about putting things away, organizing scanned items, bins, or 'the plan': it is always fresher than anything pasted into chat. To help further, create core-locations:location records for places they describe (with their confirmation); the plan routes to real locations by evidence.",
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
      "Recompute the user's put-away plan against the CURRENT workspace. Non-destructive: it only refreshes the proposal (nothing files, the user still accepts groups). Call this ONCE after you finish creating or renaming locations for them, the open plan updates automatically. Optionally pass a hint distilling what you learned in this conversation (e.g. 'the user is organizing camping gear; the hallway closet holds electronics').",
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
        note: "The user's open plan refreshes itself, summarize what changed instead of pasting the whole plan.",
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
      // "title" when the kind says "name" is the same value under a different
      // word, and refusing it taught nobody anything (see withKindsTitleField).
      const { fields } = withKindsTitleField(kind, kinds, (args.fields as Record<string, unknown>) ?? {});
      const res = await api.request("POST", `/${path}`, fields);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "create failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "create_records",
    description:
      "Create MANY records of one kind in ONE call. Use this whenever the user asks for a SET rather than a thing - \"shelf 1 to 5 in every rack\", \"bins A through H\" - instead of calling create_record over and over: it is one round trip instead of one per record, and the person watching sees one line instead of sixty. Same field names as create_record. Up to 200 at a time. Each record is created, tracked and undoable individually, and any that clash with something already there are REPORTED back to you, not forced - say so rather than trying again.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_create true"),
      records: z
        .array(z.record(z.unknown()))
        .min(1)
        .max(200)
        .describe("One object per record, each using the kind's exact field names"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const rows = Array.isArray(args.records) ? (args.records as Array<Record<string, unknown>>) : [];
      if (rows.length === 0) return toolFail("no records given");
      const kinds = await fetchKinds(api);
      const path = resolveCreatePath(kind, kinds);
      if (!path) return toolFail(`records of "${kind}" can't be created this way (no create route declared)`);
      const created: unknown[] = [];
      const failed: Array<{ index: number; error: string }> = [];
      for (const [i, row] of rows.entries()) {
        const { fields } = withKindsTitleField(kind, kinds, row);
        const res = await api.request("POST", `/${path}`, fields);
        if (res.status >= 400) failed.push({ index: i, error: apiErrorMessage(res, "create failed") });
        else created.push(res.body);
      }
      // Partial success is the NORMAL outcome here ("each rack should have
      // Shelf 1-5" against a rack that already has two of them), so it is
      // reported rather than thrown: the model needs to tell the person what
      // was already there instead of retrying into the same refusals.
      return toolOk({ created: created.length, failed, records: created });
    },
  },
  {
    name: "update_record",
    description:
      "Update fields on ONE existing record (partial update, only the fields you pass change). Only kinds with can_update are accepted.",
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
      const { fields: patch } = withKindsTitleField(kind, kinds, (args.fields as Record<string, unknown>) ?? {});
      const res = await api.request("PATCH", `/${path}`, patch);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "update failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "delete_record",
    description:
      "Delete ONE record. Only kinds with can_delete are accepted. Destructive, double-check you have the right record (get_record) before deleting.",
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
      "Run a registered action (see list_actions). Two shapes: an ENTITY action runs on one record (pass entity_kind + entity_id (adjust stock, mark done, build one, print a label). A WORKSPACE action (scope 'workspace' in list_actions) is a config/admin operation that runs on the whole workspace) OMIT entity_kind/entity_id and pass its args (e.g. rename a label-code prefix). This is how config changes happen without a record.",
    mode: "write",
    params: {
      action_id: z.string().describe("Action id, e.g. inventory:adjust-stock or labels:set-code"),
      entity_kind: z
        .string()
        .optional()
        .describe("The record's kind id — required for an entity action, omit for a workspace action"),
      entity_id: z
        .string()
        .optional()
        .describe("The record's id — required for an entity action, omit for a workspace action"),
      args: z.record(z.unknown()).optional().describe("Action arguments, by name, from the action's `args` in list_actions. Values may be any JSON — a string, a number, or a LIST (e.g. reorder takes ids: [\"…\",\"…\"])."),
    },
    execute: async (api, args) => {
      const entityKind = typeof args.entity_kind === "string" && args.entity_kind.trim() ? args.entity_kind.trim() : undefined;
      const entityId = typeof args.entity_id === "string" && args.entity_id.trim() ? args.entity_id.trim() : undefined;
      const res = await api.request("POST", "/actions/invoke", {
        actionId: String(args.action_id ?? ""),
        // Omitted entirely for a workspace action — the server skips entity
        // resolution when the action's scope is 'workspace'.
        ...(entityKind ? { entityKind } : {}),
        ...(entityId ? { entityId } : {}),
        args: (args.args as Record<string, unknown> | undefined) ?? undefined,
      });
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "action failed"));
      // The route answers 200 when the action was INVOKED; whether the operation
      // went ahead is the handler's own `result.ok`, and a handler that refuses
      // (a frozen label group, a unit that already ships built in, an argument
      // that doesn't resolve) says so there. Reading only the HTTP status
      // reported every one of those refusals to the model as a success — so it
      // told the user the change was made. 136 refusal paths across ~20 modules
      // are reachable through this one tool; unwrapping the envelope is what
      // makes "it wouldn't let me, because…" sayable at all.
      const body = res.body as { result?: unknown };
      const inner = body.result;
      if (inner && typeof inner === "object" && (inner as { ok?: unknown }).ok === false) {
        const reason = (inner as { error?: unknown }).error;
        return toolFail(
          typeof reason === "string" && reason.trim() ? reason : "the action declined to run",
        );
      }
      return toolOk(res.body);
    },
  },
  {
    name: "list_label_codes",
    description:
      "List the workspace's label-code groups (one per kind + instance, e.g. 3D Printers under Machines). Each entry has its code prefix (the letters before the number, e.g. 'p' in p42), how many codes exist, whether it is frozen (a label was printed, so existing codes are fixed), whether its code shows inside the QR, and its group_key. Call this to find the group_key, then change it by invoking the labels:set-code action (invoke_action with no entity): pass group_key plus prefix and/or code_in_qr (the QR toggle is per group, so 3d printers can differ from cnc).",
    mode: "read",
    params: {},
    execute: async (api) => {
      const res = await api.request("GET", "/modules/labels/codes/groups");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list label codes"));
      return toolOk((res.body as { groups?: unknown[] }).groups ?? []);
    },
  },
];

export function getTool(name: string): WorkspaceTool | undefined {
  return WORKSPACE_TOOLS.find((t) => t.name === name);
}

export const READ_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "read");
export const WRITE_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "write");

// ─────────────────────── the MCP naming policy, once ──────────────────────
//
// Three surfaces read this registry: the in-app chat (bare names), and TWO MCP
// faces — the stdio server (packages/mcp-server) and the HTTP endpoint
// (api/src/platform/hosted-mcp.ts). Both MCP faces prefix every tool the same
// way, and both used to hardcode that prefix themselves. Two copies of a naming
// policy is how one face ends up exposing a different set from the other, which
// is precisely what happened: the HTTP face carried a hand-kept SIX while this
// registry held twenty-one, and nothing noticed because a model with fewer
// tools does not error, it just answers (2026-08-15).
//
// The per-transport parts stay per-transport: each face describes its own
// `workspace` argument in its own terms (an env var for stdio, a query param
// for HTTP), because those genuinely differ.

/** The prefix both MCP faces put on every workspace tool. */
export const MCP_TOOL_PREFIX = "cobblr_";

/** A registry tool's name as MCP clients see it. */
export function mcpToolName(bareName: string): string {
  return `${MCP_TOOL_PREFIX}${bareName}`;
}

/** MCP name → the registry tool it addresses (null when it isn't one of ours). */
export function toolFromMcpName(mcpName: string): WorkspaceTool | undefined {
  return mcpName.startsWith(MCP_TOOL_PREFIX)
    ? getTool(mcpName.slice(MCP_TOOL_PREFIX.length))
    : undefined;
}
