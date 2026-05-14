// Auth middleware. Reads Bearer <jwt>, verifies, looks up the user,
// and attaches a typed `req.session` to the request.
//
// The handler doesn't care about org context — that's the job of
// tenant routing (milestone 3). Here we just establish "who is this
// person and are they still active."

import type { NextFunction, Request, Response } from "express";
import { meta } from "../db/meta.js";
import { verifySession } from "./jwt.js";

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
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
    const claims = await verifySession(token);
    const user = await meta
      .selectFrom("users")
      .select(["id", "email", "display_name", "active"])
      .where("id", "=", claims.sub)
      .executeTakeFirst();
    if (!user || !user.active) {
      res.status(401).json({
        error: { code: "unauthenticated", message: "User not found or inactive" },
      });
      return;
    }
    req.session = { id: user.id, email: user.email, display_name: user.display_name };
    next();
  } catch (err) {
    res.status(401).json({
      error: { code: "unauthenticated", message: (err as Error).message },
    });
  }
}
