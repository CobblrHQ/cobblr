// A server-sent event stream for a browser tab: a short-lived ticket (an
// EventSource cannot send an Authorization header, so an authed POST mints
// one), and the stream itself with a heartbeat. One implementation for every
// stream the web opens (the drive session's tab, the notification bell).
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";
import { roleSatisfies, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import type { SignIn } from "../platform/sign-ins-ended.js";

/** The sign-in a request was made with, as a stream remembers it. */
export function signInOf(session: { id: string; issued_at?: number | null; api_token_id: string | null }): SignIn {
  return { userId: session.id, issuedAt: session.issued_at ?? null, apiTokenId: session.api_token_id };
}

const secret = () => new TextEncoder().encode(env.JWT_SECRET);
const TICKET_TTL_S = 60;

/** A ticket for one stream (`audience`), naming the sign-in that minted it
 *  (so the stream can ask whether that still stands) and any extra claims. */
export async function signStreamTicket(audience: string, signIn: SignIn, claims: Record<string, string> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, sat: signIn.issuedAt, tid: signIn.apiTokenId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cobblr")
    .setAudience(audience)
    .setSubject(signIn.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + TICKET_TTL_S)
    .sign(secret());
}

/** The ticket's claims when it is valid for `audience`, else null. */
export async function verifyStreamTicket(audience: string, ticket: string): Promise<({ userId: string; signIn: SignIn } & Record<string, unknown>) | null> {
  try {
    const { payload } = await jwtVerify(ticket, secret(), { issuer: "cobblr", audience, algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    const signIn: SignIn = {
      userId: payload.sub,
      issuedAt: typeof payload.sat === "number" ? payload.sat : null,
      apiTokenId: typeof payload.tid === "string" ? payload.tid : null,
    };
    // A ticket from before tickets named their sign-in is dated by itself: it
    // was minted inside a sign-in that stood then, and lives a minute.
    if (signIn.issuedAt === null && signIn.apiTokenId === null && typeof payload.iat === "number") signIn.issuedAt = payload.iat;
    return { ...payload, userId: payload.sub, signIn };
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

/** How long a stream trusts its last "may still hear" before it asks again,
 *  ahead of the next thing it sends. */
const MEMBER_RECHECK_MS = 10_000;

type Stream = { send: (event: string, data: unknown) => void; stop: () => void };

/** An open stream that asks `mayHear` again whenever `subscribe`'s listeners
 *  fire, and before a send whenever its last answer is older than
 *  MEMBER_RECHECK_MS, and closes the moment the answer is no. */
function guardedSse(res: Response, mayHear: () => Promise<boolean>, subscribe: Array<(askAgain: () => void) => () => void>): Stream {
  const inner = openSse(res);
  let closed = false;
  let checkedAt = Date.now();
  let queue: Promise<void> = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    inner.stop();
    try {
      res.end();
    } catch {
      /* already gone */
    }
  };
  // Told something that may end it (a membership, a role, every sign-in):
  // ask again before the next send goes, and close if the answer is no.
  const askAgain = () => {
    checkedAt = 0;
    queue = queue.then(async () => {
      if (!closed && !(await mayHear())) close();
    });
  };
  const offs = subscribe.map((on) => on(askAgain));
  const offEnded = () => {
    for (const off of offs) off();
  };
  res.on("close", () => {
    closed = true;
    offEnded();
  });
  return {
    send: (event, data) => {
      if (closed) return;
      queue = queue.then(async () => {
        if (closed) return;
        if (Date.now() - checkedAt > MEMBER_RECHECK_MS) {
          checkedAt = Date.now();
          // Unanswered is not yes: the tab reconnects through a fresh ticket, which asks again.
          if (!(await mayHear())) return close();
        }
        if (!closed) inner.send(event, data);
      });
    },
    stop: () => {
      inner.stop();
      offEnded();
    },
  };
}

const SIGNED_OUT = { error: { code: "signed_out", message: "You were signed out. Sign in again." } };

/** Open a stream that is a person's own, across every workspace (their
 *  notifications), only while the sign-in that opened it stands (#4115): a
 *  lost phone's stream ends when its owner signs out everywhere, changes the
 *  password or deletes the account. Answers 401 and returns null when that
 *  sign-in has ended. */
export async function openPersonSse(res: Response, signIn: SignIn): Promise<Stream | null> {
  const { signInStands, onSignInsEnded } = await import("../platform/sign-ins-ended.js");
  const stands = () => signInStands(signIn).catch(() => false);
  if (!(await stands())) {
    res.status(401).json(SIGNED_OUT);
    return null;
  }
  return guardedSse(res, stands, [(again) => onSignInsEnded(signIn.userId, again)]);
}

/** Open a stream on one workspace for one person, only while the sign-in that
 *  opened it stands and they hold at least `least` in it (#4115). Asked when
 *  it opens (a ticket outlives a removal or a sign-out by up to a minute),
 *  closed the moment their membership ends, their role drops below `least`
 *  or every sign-in of theirs ends (announceMembershipEnded,
 *  announceRoleChanged, announceSignInsEnded), and asked again before it sends
 *  when its last answer is older than MEMBER_RECHECK_MS, so a path that ends
 *  any of those without announcing it is caught too. Answers 401, or 403, and
 *  returns null when they may not hear it. Every stream opens here or in
 *  openPersonSse (code:workspace-stream). */
export async function openWorkspaceSse(
  res: Response,
  who: { orgId: string; signIn: SignIn },
  /** The least role this stream may carry anything to (#4115): a role lowered
   *  below it closes the stream, as a removal does. */
  least: OrgRoleName = "guest",
): Promise<Stream | null> {
  const { roleNow, onMembershipEnded } = await import("../platform/membership-ended.js");
  const { signInStands, onSignInsEnded } = await import("../platform/sign-ins-ended.js");
  const userId = who.signIn.userId;
  const stands = () => signInStands(who.signIn).catch(() => false);
  const mayHear = async () => (await stands()) && roleSatisfies(await roleNow(who.orgId, userId).catch(() => null), [least]);
  if (!(await stands())) {
    res.status(401).json(SIGNED_OUT);
    return null;
  }
  if (!(await mayHear())) {
    const member = (await roleNow(who.orgId, userId).catch(() => null)) !== null;
    res.status(403).json(
      member
        ? { error: { code: "role_too_low", message: `This live stream is for a ${least} or above; your role in this workspace cannot hear it.` } }
        : { error: { code: "not_a_member", message: "You are not a member of this workspace." } },
    );
    return null;
  }
  return guardedSse(res, mayHear, [
    (again) => onMembershipEnded(who.orgId, userId, again),
    (again) => onSignInsEnded(userId, again),
  ]);
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
