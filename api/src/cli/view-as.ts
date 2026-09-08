// "View as" from the deploy box: the second door into a support session.
//
//   node dist/cli/view-as.js list
//   node dist/cli/view-as.js start --org <uuid> --user <uuid> --reason "<text>" [--ttl <min>]
//   node dist/cli/view-as.js end <session-id>
//   node dist/cli/view-as.js log
//
// WHY A SECOND DOOR. The HTTP door needs an admin API token, and the person
// with the box did not want a token per agent piling up in the console - nor
// did a token gate anything: an agent with ssh and docker on this box can already
// read every tenant database, unaudited, and that is what they were doing. This
// door mints nothing that is stored. The session JWT and the impersonation JWT
// are signed on the fly and expire; the only row written is the
// impersonation_sessions entry, which is the audit ledger and is supposed to
// grow. Against the psql it replaces it is read-only, time-boxed, and recorded
// in the operator log. (Not the member's feed: the owner decided 2026-09-08 that
// users should not see "support looked here".)
//
// It runs INSIDE the api container (docker exec), so it has the same env, the
// same signing secret and the same database as the api - being inside the
// container is the authority, and nothing weaker gets here. It is deliberately
// not an HTTP route: a route would need a credential, and the whole point is
// that on the box there is nothing left to gate.
//
// READ-ONLY ONLY. This cannot arm write mode. Write mode stays a separate,
// explicit, audited PATCH through the console, so "an agent looked" and
// "something changed" remain different events with different gates.
//
// WHO IS THE OPERATOR. There is no logged-in admin on the box. The session is
// attributed to a platform-admin account (the first SUPERADMIN_EMAILS entry, or
// --operator <email>), which is true at the accountability level, and the reason
// is prefixed "[agent]" so the operator log distinguishes automation from a
// person clicking in the console.

import { writeSync } from "node:fs";

import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { signSession, signImpersonation } from "../auth/jwt.js";
import { ImpersonationRefused, startImpersonation, describeSession } from "../platform/impersonation.js";

const AGENT_PREFIX = "[agent] ";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// stdout/stderr are PIPES here (docker exec), and on a pipe Node's stream write
// is asynchronous: process.exit() right after it drops everything past the
// first ~64 KiB. `list` on a real instance is bigger than that, and the JSON
// arrived cut mid-string on 2026-09-08. writeSync is the fix; the exit below is
// still needed because the meta pool would otherwise keep the process alive.
function out(text: string): void {
  writeSync(1, text);
}

function fail(msg: string, code = 1): never {
  writeSync(2, `view-as: ${msg}\n`);
  process.exit(code);
}

async function operatorId(): Promise<string> {
  const chosen = arg("operator");
  const email = (chosen ?? (env.SUPERADMIN_EMAILS ?? "").split(",")[0] ?? "").trim().toLowerCase();
  if (!email) fail("no operator: SUPERADMIN_EMAILS is empty and --operator was not given");
  const row = await meta.selectFrom("users").select(["id"]).where("email", "=", email).executeTakeFirst();
  if (!row) fail(`operator ${email} is not a user on this instance`);
  return row.id;
}

async function list(): Promise<void> {
  const orgs = await meta.selectFrom("orgs").select(["id", "slug", "name", "plan"]).orderBy("name").execute();
  const members = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.org_id", "m.role", "u.id as user_id", "u.email", "u.display_name"])
    .execute();
  const byOrg = new Map<string, typeof members>();
  for (const m of members) byOrg.set(m.org_id, [...(byOrg.get(m.org_id) ?? []), m]);
  out(JSON.stringify({ workspaces: orgs.map((o) => ({ ...o, members: byOrg.get(o.id) ?? [] })) }, null, 2) + "\n");
}

async function start(): Promise<void> {
  const orgId = arg("org") ?? fail("--org <uuid> is required");
  const targetUserId = arg("user") ?? fail("--user <uuid> is required");
  const reason = (arg("reason") ?? "").trim();
  if (!reason) fail("--reason is required: it is the operator log's record of why");
  const ttl = arg("ttl");
  const ttlMin = ttl ? Number(ttl) : undefined;
  if (ttl && !Number.isInteger(ttlMin)) fail("--ttl must be whole minutes");

  const operator = await operatorId();
  try {
    const started = await startImpersonation({
      orgId,
      targetUserId,
      reason: reason.startsWith(AGENT_PREFIX) ? reason : AGENT_PREFIX + reason,
      ...(ttlMin === undefined ? {} : { ttlMin }),
      operatorUserId: operator,
    });
    // The token is NOT returned to the caller: it never needs to leave the box,
    // because `read` re-signs from the session id. Return only what is safe to
    // hold on a workstation.
    out(
      JSON.stringify({
        session_id: started.session_id,
        expires_at: started.expires_at,
        mode: started.mode,
        target: started.target,
        workspace: started.workspace,
      }) + "\n",
    );
  } catch (e) {
    if (e instanceof ImpersonationRefused) fail(`${e.code}: ${e.message}`, 2);
    throw e;
  }
}

async function read(): Promise<void> {
  const sessionId = arg("session") ?? fail("--session <id> is required (from start / log)");
  const path = arg("path") ?? fail("--path </orgs/<slug>/...> is required");
  if (!path.startsWith("/")) fail("--path must start with /");

  const sess = await meta
    .selectFrom("impersonation_sessions as s")
    .innerJoin("orgs as o", "o.id", "s.org_id")
    .select(["s.operator_user_id", "s.target_user_id", "s.org_id", "s.expires_at", "s.ended_at", "s.mode", "o.slug"])
    .where("s.id", "=", sessionId)
    .executeTakeFirst();
  if (!sess) fail(`no session ${sessionId}`, 2);
  if (sess.ended_at) fail(`session ${sessionId} was ended`, 2);
  const remainingSec = Math.floor((sess.expires_at.getTime() - Date.now()) / 1000);
  if (remainingSec <= 0) fail(`session ${sessionId} expired`, 2);

  // Two fresh, in-memory tokens: the operator session so the request
  // authenticates at all, and the impersonation token so it resolves as the
  // target. Both expire with the session; neither is written anywhere.
  const [operatorTok, impTok] = await Promise.all([
    signSession(sess.operator_user_id),
    signImpersonation(sess.operator_user_id, sess.target_user_id, sess.org_id, sessionId, remainingSec),
  ]);

  // Localhost, inside the container, through the real middleware: read-only
  // enforcement, workspace-disabled and every other guard apply exactly as they
  // would to a browser. GET only - this command cannot express a mutation.
  // 127.0.0.1, not localhost: the same address the image's healthcheck uses, so
  // there is no IPv6-first resolution to disagree with what the api bound.
  const origin = `http://127.0.0.1:${env.API_PORT}`;
  const url = path.startsWith("/api/v1") ? origin + path : `${origin}/api/v1${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${operatorTok}`, "X-Impersonation": impTok, "X-Org-Slug": sess.slug },
    });
  } catch (e) {
    // undici's "fetch failed" hides the reason in `cause`; without it a
    // connection refusal and a bad header look identical from the outside.
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
    fail(`GET ${url} failed: ${cause ? `${(cause as NodeJS.ErrnoException).code ?? ""} ${cause.message}`.trim() : (e as Error).message}`, 3);
  }
  const body = await res.text();
  if (!res.ok) fail(`GET ${path} -> ${res.status}\n${body}`, 3);
  out(body.endsWith("\n") ? body : body + "\n");
}

async function end(): Promise<void> {
  const id = process.argv[3] ?? fail("end needs a session id");
  const r = await meta
    .updateTable("impersonation_sessions")
    .set({ ended_at: new Date() })
    .where("id", "=", id)
    .where("ended_at", "is", null)
    .executeTakeFirst();
  out(Number(r.numUpdatedRows) ? `ended ${id}\n` : `session ${id} was not open\n`);
}

async function log(): Promise<void> {
  const rows = await meta
    .selectFrom("impersonation_sessions as s")
    .innerJoin("users as t", "t.id", "s.target_user_id")
    .innerJoin("orgs as o", "o.id", "s.org_id")
    .select(["s.id", "s.created_at", "s.expires_at", "s.ended_at", "s.reason", "s.request_count", "s.mode", "o.slug as workspace", "t.email as target"])
    .orderBy("s.created_at", "desc")
    .limit(50)
    .execute();
  const sessions = rows.map((r) => ({ ...r, summary: describeSession({ ...r, operator: null }) }));
  out(JSON.stringify({ sessions }, null, 2) + "\n");
}

const cmd = process.argv[2];
const run = { list, start, read, end, log }[cmd ?? ""];
if (!run) fail("usage: view-as.js <list|start|read|end|log> ...");
run()
  .then(() => process.exit(0))
  .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
