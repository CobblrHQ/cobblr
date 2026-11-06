// POST /me/api-tokens/end-all: "End them too" on a new password's confirmation.
import { Router } from "express";
import { requireAuth } from "../../auth/middleware.js";
import { endApiTokensAndLog, endedSentence } from "../../platform/api-tokens-after-password.js";

export const endApiTokensRouter = Router();

// AI-REACH: platform:end-my-api-tokens
endApiTokensRouter.post("/me/api-tokens/end-all", requireAuth, async (req, res, next) => {
  try {
    const ended = await endApiTokensAndLog(req.session!.id);
    res.json({ ...ended, message: endedSentence(ended) });
  } catch (err) {
    next(err);
  }
});
