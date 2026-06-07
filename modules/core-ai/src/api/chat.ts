// Agentic chat — the assistant can DO things, not just talk. One AI call per
// turn returns ONE structured move: a plain reply, a proposed CREATE, or a
// proposed ACTION on an existing record. Writes never run here — they're
// returned as a "proposal" the user confirms via POST /chat/execute. Entity
// resolution for actions (name → id) happens server-side via core-search.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, sessionUserId } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const chatRouter = Router({ mergeParams: true });

// Kind → that module's create endpoint (mirrors core-scan's commit map). Only
// these kinds can be created from chat for now; extend as modules expose more.
const KIND_CREATE_PATHS: Record<string, string> = {
  "inventory:part": "inventory/parts",
  "machines:machine": "machines/machines",
  "assets:asset": "assets/assets",
  "projects:project": "projects/projects",
  "projects:task": "projects/tasks",
  "lists:list": "lists/lists",
  "lists:item": "lists/items",
};

interface Ctx {
  slug: string;
  auth: string;
  base: string;
}
function ctxOf(req: Parameters<typeof tenantContext>[0]): Ctx {
  return {
    slug: tenantContext(req).org.slug,
    auth: req.headers.authorization ?? "",
    base: `http://127.0.0.1:${process.env.API_PORT ?? "4000"}/api/v1`,
  };
}

async function callApi(
  c: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${c.base}/orgs/${c.slug}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: c.auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body: b };
}

// ── context for the prompt: kinds + their wireable actions ──
interface Move {
  type: "reply" | "create" | "action" | "build";
  text?: string;
  entity_kind?: string;
  fields?: Record<string, unknown>;
  action_id?: string;
  entity_query?: string;
  intent?: string;
  summary?: string;
}

async function buildSystemPrompt(c: Ctx): Promise<string> {
  const kindsRes = await callApi(c, "GET", "/entity-kinds");
  const kinds = (kindsRes.body.items as Array<{ id: string; display_name: string }> | undefined) ?? [];
  const kindLines = kinds.map((k) => `- ${k.id} (${k.display_name})`).join("\n") || "(none)";

  // Actions per kind (a few in-process inspect calls).
  const actionLines: string[] = [];
  for (const k of kinds) {
    const insp = await callApi(c, "GET", `/actions/inspect?kind=${encodeURIComponent(k.id)}`);
    const acts = (insp.body.actions as Array<{ id: string; label: string; description?: string }> | undefined) ?? [];
    for (const a of acts) actionLines.push(`- ${a.id} (on ${k.id}) — ${a.label}${a.description ? `: ${a.description}` : ""}`);
  }
  const createable = kinds.map((k) => k.id).filter((id) => id in KIND_CREATE_PATHS);

  return `You are the assistant inside the user's Cobblr workspace "${c.slug}". You can chat AND take actions for the user — but you only PROPOSE a write; the user confirms before anything runs.

ENTITY KINDS in this workspace:
${kindLines}

You can CREATE new records of these kinds: ${createable.join(", ") || "(none)"}

ACTIONS you can run on existing records:
${actionLines.join("\n") || "(none)"}

Reply with ONE JSON object and nothing else, in ONE of these shapes:
- Chat/answer/ask:   {"type":"reply","text":"<your message>"}
- Create a record:   {"type":"create","entity_kind":"<id>","fields":{"name":"<...>", ...},"summary":"<one line, e.g. Create a part called Widget>"}
- Run an action:     {"type":"action","action_id":"<id>","entity_kind":"<id>","entity_query":"<the record's name to find it>","summary":"<one line>"}
- Build a whole app:  {"type":"build","intent":"<the user's FULL description of the workspace/app to set up>","summary":"<one line, e.g. Set up a yarn & crochet tracker>"}

Rules:
- Use entity_kind / action_id values EXACTLY from the lists above. Never invent ids.
- create: include at least a "name" (or "title") in fields; add other obvious fields the user gave.
- action: entity_query is the name/text to find the existing record — the system looks it up.
- Use "build" when the user wants to SET UP or DESIGN a new app/workspace, or add several kinds/modules at once (more than a single field/record). Put their full description verbatim-ish in "intent" — the builder turns on the modules and creates the fields. Do NOT use "build" for a single record or one field; use create/reply for those.
- If you only have a kind/action that isn't listed, or you're missing info, use "reply" to chat or ask.`;
}

function parseMove(raw: string): Move | null {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try {
    const o = JSON.parse(raw.slice(s, e + 1)) as Move;
    return o && typeof o === "object" && typeof o.type === "string" ? o : null;
  } catch {
    return null;
  }
}

const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1).max(40),
});

chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const c = ctxOf(req);
    const orgId = tenantContext(req).org.id;

    let system: string;
    try {
      system = await buildSystemPrompt(c);
    } catch {
      system = `You are the assistant inside the Cobblr workspace "${c.slug}". Chat helpfully; reply with {"type":"reply","text":"..."}.`;
    }

    let text: string;
    try {
      const r = await platform().ai.invoke({
        orgId,
        capability: "chat",
        input: { messages: [{ role: "system", content: system }, ...parsed.data.messages] },
        source: { kind: "core-ai:chat", id: orgId },
        userId: sessionUserId(req),
      });
      const result = r.result as { content?: string; text?: string } | string;
      text = typeof result === "string" ? result : result?.content ?? result?.text ?? "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(/no provider|not entitled|not available/i.test(msg) ? 409 : 502).json({
        type: "error",
        error: { code: "no_ai", message: msg },
      });
      return;
    }

    const move = parseMove(text);
    if (!move || move.type === "reply") {
      res.json({ type: "reply", text: move?.text ?? text });
      return;
    }

    if (move.type === "create") {
      if (!move.entity_kind || !(move.entity_kind in KIND_CREATE_PATHS)) {
        res.json({ type: "reply", text: `I can't create "${move.entity_kind ?? "that"}" from chat yet.` });
        return;
      }
      res.json({
        type: "proposal",
        summary: move.summary ?? `Create a ${move.entity_kind}`,
        proposal: { kind: "create", entity_kind: move.entity_kind, fields: move.fields ?? {} },
      });
      return;
    }

    // build — design a whole workspace. The core-authoring design-workspace
    // engine runs ~150s (enable modules + build fields/wires + auto-repair), so
    // /build returns immediately with a "building" draft and we hand the draft
    // id back to the client to POLL (GET .../drafts/:id). Blocking here would
    // bust the chat request's own proxy timeout. The widget shows the preview +
    // a confirm once the draft finishes.
    if (move.type === "build") {
      if (!move.intent || !move.intent.trim()) {
        res.json({ type: "reply", text: "Tell me what you'd like your workspace to do and I'll set it up." });
        return;
      }
      const br = await callApi(c, "POST", "/modules/core-authoring/build", {
        intent: move.intent.trim(),
        task: "design-workspace",
      });
      if (br.status === 409) {
        res.json({ type: "reply", text: "Setting up a whole workspace needs AI enabled here — it isn't yet." });
        return;
      }
      const b = br.body as { draft_id?: string };
      if (!b.draft_id) {
        res.json({ type: "reply", text: "I couldn't start the build just now — give it another try in a moment." });
        return;
      }
      // building: true → the widget polls the draft, then renders preview + confirm.
      res.json({
        type: "build-proposal",
        building: true,
        draft_id: b.draft_id,
        summary: move.summary ?? "Designing your workspace…",
      });
      return;
    }

    // action — resolve the entity by name via search before proposing.
    if (move.type === "action") {
      if (!move.action_id || !move.entity_kind || !move.entity_query) {
        res.json({ type: "reply", text: "I need a bit more to do that — which record exactly?" });
        return;
      }
      const sr = await callApi(
        c,
        "GET",
        `/modules/core-search/search?q=${encodeURIComponent(move.entity_query)}&kinds=${encodeURIComponent(move.entity_kind)}`,
      );
      const hits = ((sr.body.items as Array<{ id: string; kind?: string; title?: string }> | undefined) ?? []).filter(
        (h) => !h.kind || h.kind === move.entity_kind,
      );
      if (hits.length === 0) {
        res.json({ type: "reply", text: `I couldn't find a ${move.entity_kind} matching "${move.entity_query}".` });
        return;
      }
      if (hits.length > 1) {
        const names = hits.slice(0, 6).map((h) => `“${h.title ?? h.id}”`).join(", ");
        res.json({ type: "reply", text: `I found a few matching "${move.entity_query}": ${names}. Which one?` });
        return;
      }
      const hit = hits[0]!;
      res.json({
        type: "proposal",
        summary: move.summary ?? `Run ${move.action_id} on “${hit.title ?? hit.id}”`,
        proposal: {
          kind: "action",
          action_id: move.action_id,
          entity_kind: move.entity_kind,
          entity_id: hit.id,
          entity_label: hit.title ?? hit.id,
        },
      });
      return;
    }

    res.json({ type: "reply", text });
  }),
);

// ── POST /chat/execute — run a confirmed proposal ──
const ExecBody = z.object({
  proposal: z.union([
    z.object({ kind: z.literal("create"), entity_kind: z.string(), fields: z.record(z.unknown()) }),
    z.object({ kind: z.literal("action"), action_id: z.string(), entity_kind: z.string(), entity_id: z.string() }),
    z.object({ kind: z.literal("build"), draft_id: z.string() }),
  ]),
});

chatRouter.post(
  "/execute",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ExecBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const c = ctxOf(req);
    const p = parsed.data.proposal;

    if (p.kind === "create") {
      const path = KIND_CREATE_PATHS[p.entity_kind];
      if (!path) {
        res.status(400).json({ ok: false, message: `Can't create ${p.entity_kind}.` });
        return;
      }
      const r = await callApi(c, "POST", `/modules/${path}`, p.fields);
      if (r.status >= 400) {
        res.status(r.status).json({ ok: false, message: (r.body.error as { message?: string } | undefined)?.message ?? "Create failed." });
        return;
      }
      const created = r.body as { id?: string; name?: string; title?: string };
      res.json({ ok: true, message: `Created ${created.name ?? created.title ?? p.entity_kind}.`, entity: { kind: p.entity_kind, id: created.id } });
      return;
    }

    if (p.kind === "build") {
      // Apply the validated design-workspace draft (install re-validates +
      // enables the required modules, then seeds any planned starter records).
      const r = await callApi(c, "POST", `/modules/core-authoring/drafts/${p.draft_id}/apply`, { confirm: true });
      if (r.status >= 400) {
        res.status(r.status).json({
          ok: false,
          message: (r.body.error as { message?: string } | undefined)?.message ?? "Couldn't set up the workspace.",
        });
        return;
      }
      const created = (r.body.seeded as { created?: number } | undefined)?.created ?? 0;
      res.json({
        ok: true,
        message:
          "Your workspace is set up — modules enabled and fields added" +
          (created > 0 ? `, plus ${created} starter record${created === 1 ? "" : "s"} created.` : "."),
      });
      return;
    }

    // action
    const r = await callApi(c, "POST", `/actions/invoke`, {
      actionId: p.action_id,
      entityKind: p.entity_kind,
      entityId: p.entity_id,
    });
    if (r.status >= 400) {
      res.status(r.status).json({ ok: false, message: (r.body.error as { message?: string } | undefined)?.message ?? "Action failed." });
      return;
    }
    res.json({ ok: true, message: `Done.` });
  }),
);
