// A server-sent event stream for a browser tab: a short-lived ticket (an
// EventSource cannot send an Authorization header, so an authed POST mints
// one), and the stream itself with a heartbeat. One implementation for every
// stream the web opens (the drive session's tab, the notification bell).
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

const secret = () => new TextEncoder().encode(env.JWT_SECRET);
const TICKET_TTL_S = 60;

/** A ticket for one stream (`audience`), naming the user and any extra claims. */
export async function signStreamTicket(audience: string, userId: string, claims: Record<string, string> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cobblr")
    .setAudience(audience)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + TICKET_TTL_S)
    .sign(secret());
}

/** The ticket's claims when it is valid for `audience`, else null. */
export async function verifyStreamTicket(audience: string, ticket: string): Promise<({ userId: string } & Record<string, unknown>) | null> {
  try {
    const { payload } = await jwtVerify(ticket, secret(), { issuer: "cobblr", audience, algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? { ...payload, userId: payload.sub } : null;
  } catch {
    return null;
  }
}

/** Every stream this process has open, so a shutdown can end them. */
const open = new Set<Response>();

/** Open an SSE stream and return a typed `send`. Heartbeats every 25s so proxies
 *  don't reap the idle connection; the caller wires req.on("close"). */
export function openSse(res: Response): { send: (event: string, data: unknown) => void; stop: () => void } {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  // SINGLE-PROCESS-SAFE: a keepalive on one open response, not a background job.
  const hb = setInterval(() => res.write(": ping\n\n"), 25000);
  open.add(res);
  res.on("close", () => {
    clearInterval(hb);
    open.delete(res);
  });
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    stop: () => clearInterval(hb),
  };
}

/** End every open stream, telling each browser to reconnect in half a second.
 *  A stream never ends on its own, so without this a shutdown's server.close()
 *  waited out its whole drain on them and was killed, cutting every tab at
 *  once (#6708). The browser's EventSource reconnects through the front to
 *  whichever api is still serving. Returns how many it ended. */
export function endOpenStreams(): number {
  const n = open.size;
  for (const res of open) {
    try {
      res.end("retry: 500\n\n");
    } catch {
      /* already gone */
    }
  }
  open.clear();
  return n;
}
