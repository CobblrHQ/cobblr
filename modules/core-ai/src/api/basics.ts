// Ask Cobblr "basic mode" — the no-AI floor, server side. When a workspace has
// no AI provider, the chat calls POST /basics/answer instead of the model, and
// gets a lexical, deterministic answer from the built-in catalog (see
// basics-catalog.ts). No provider, no cost, no dead-end.
//
// Phase 1 matches the built-in catalog only. Per-workspace overrides + custom
// rules + miss capture land later (docs/design-decisions/no-ai-chat-training.md);
// the effective ruleset will overlay a `core_ai_basics` table onto these.

import { Router } from "express";
import { z } from "zod";
import { BUILTIN_BASICS } from "../basics-catalog.js";
import { matchBasics } from "../basics-match.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const basicsRouter = Router({ mergeParams: true });

// GET /basics — the effective ruleset (built-ins today). Replies included so a
// management UI / tester can render them; no secrets here.
basicsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json({
      rules: BUILTIN_BASICS.map((r) => ({ key: r.key, intent: r.intent, keywords: r.keywords, reply: r.reply })),
    });
  }),
);

const AnswerBody = z.object({ message: z.string().min(1).max(2000) });

// POST /basics/answer — match a message → reply. Used by the chat's no-AI path
// and (later) the settings "try it" tester. Always returns a reply (the
// graceful no-match nudge when nothing scores), plus the ranked candidates.
basicsRouter.post(
  "/answer",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const result = matchBasics(parsed.data.message, BUILTIN_BASICS);
    res.json(result);
  }),
);
