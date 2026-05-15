// Auth middleware. Reads Bearer <jwt>, verifies, looks up the user,
// and attaches a typed `req.session` to the request.
//
// The handler doesn't care about org context — that's the job of
// tenant routing (milestone 3). Here we just establish "who is this
// person and are they still active."

import type { NextFunction, Request, Response } from "express";
import { meta } from "../db/meta.js";
import { verifySession } from "./jwt.js";
import { resolveApiToken } from "./api-tokens.js";
import { runWithActor } from "../lib/request-context.js";

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  /** How this request was authenticated — set by requireAuth. */
  auth_method: "session" | "api_token";
  /** If auth_method === "api_token", the id of the token that signed
   *  the request. Used for the activity-log audit trail. */
  api_token_id: string | null;
}

// Augment Express's Request without leaking the field globally —
// declare it here and import where needed.
declare module "express-serve-static-core" {
  interface Request {
    session?: SessionUser;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Missing bearer token" } });
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    // Two acceptable token formats:
    //   1. Session JWT (issued by login/signup, browser-side).
    //   2. Long-lived API token `cbt_<...>` (minted via /me/api-tokens,
    //      used by CLI / AI / automation).
    // The `cbt_` prefix is unambiguous — JWTs always start with the
    // base64url of `{"alg":...` which begins `eyJ`.
    let userId: string | null = null;
    let authMethod: "session" | "api_token" = "session";
    let apiTokenId: string | null = null;
    if (token.startsWith("cbt_")) {
      const resolved = await resolveApiToken(token);
      if (resolved) {
        userId = resolved.userId;
        authMethod = "api_token";
        apiTokenId = resolved.tokenId;
      }
    } else {
      const claims = await verifySession(token);
      userId = claims.sub;
    }
    if (!userId) {
      res.status(401).json({
        error: { code: "unauthenticated", message: "Token not valid" },
      });
      return;
    }
    const user = await meta
      .selectFrom("users")
      .select(["id", "email", "display_name", "active"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user || !user.active) {
      res.status(401).json({
        error: { code: "unauthenticated", message: "User not found or inactive" },
      });
      return;
    }
    req.session = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      auth_method: authMethod,
      api_token_id: apiTokenId,
    };
    // Wrap the rest of the request chain in actor context so any
    // deeply-nested activity.log() call automatically picks up
    // user id + auth method + token id.
    runWithActor(
      { userId: user.id, authMethod, apiTokenId },
      () => next(),
    );
  } catch (err) {
    res.status(401).json({
      error: { code: "unauthenticated", message: (err as Error).message },
    });
  }
}
