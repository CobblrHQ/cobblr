// A sandbox for an operator, made from the box: scripts/try-sandbox.sh.
//
//   node dist/cli/try-sandbox.js mint --reason "<text>" [--operator <email>] [--start scan]
//   node dist/cli/try-sandbox.js log
//
// WHY A SECOND DOOR. The public door (/try/start) stands behind a captcha,
// which is right for strangers and is exactly what stops an agent walking the
// sandbox to check it. This door is not public: it runs INSIDE the api
// container (docker exec), the way view-as does, and being on the box is the
// authority. The public door is unchanged and keeps its challenge.
//
// WHAT IT MAKES. An ordinary sandbox, through the same steps the public door
// runs (routes/try-sandbox-start.ts): the cap, the pool, the seed, the hour.
// It differs only in what it says: nothing is announced, no visitor event is
// written, and the workspace is recorded in operator_sandboxes, which every
// count of visitors and signups leaves out (usage-stats, signups-by-source).
//
// WHO IS THE OPERATOR. The first SUPERADMIN_EMAILS entry, or --operator
// <email>, as in view-as; the reason is prefixed "[agent]" so the ledger tells
// automation from a person.
import { writeSync } from "node:fs";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { sandboxEnabled } from "../platform/try-sandbox.js";
import { publicBaseUrl } from "../platform/public-url.js";
import { operatorSandboxLog, recordOperatorSandbox } from "../platform/operator-sandboxes.js";
import { startSandbox } from "../routes/try-sandbox-start.js";

const AGENT_PREFIX = "[agent] ";
const STARTS = new Set(["scan"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// docker exec gives us pipes, and a pipe write is asynchronous: exit right
// after it drops the tail (view-as.ts says how that was found).
function out(text: string): void {
  writeSync(1, text);
}

function fail(msg: string, code = 1): never {
  writeSync(2, `try-sandbox: ${msg}\n`);
  process.exit(code);
}

async function operator(): Promise<{ id: string; email: string }> {
  const email = (arg("operator") ?? (env.SUPERADMIN_EMAILS ?? "").split(",")[0] ?? "").trim().toLowerCase();
  if (!email) fail("no operator: SUPERADMIN_EMAILS is empty and --operator was not given");
  const row = await meta.selectFrom("users").select(["id"]).where("email", "=", email).executeTakeFirst();
  if (!row) fail(`operator ${email} is not a user on this instance`);
  return { id: row.id, email };
}

async function mint(): Promise<void> {
  if (!sandboxEnabled()) fail("this box does not hand out sandboxes (COBBLR_TRY_SANDBOX is not on)", 3);
  const reason = (arg("reason") ?? "").trim();
  if (!reason) fail("--reason is required: it is the ledger's record of why");
  const start = arg("start");
  if (start && !STARTS.has(start)) fail(`--start must be one of ${[...STARTS].join(", ")} (got '${start}')`);
  const base = publicBaseUrl();
  if (!base) fail("this box has no public address configured, so there is no link to print");
  const who = await operator();
  // stdout carries one JSON line for the script; the shared steps narrate
  // (pool, seed, covers), and that goes to stderr where the script shows it.
  console.log = console.info = (...a: unknown[]) => void writeSync(2, a.map(String).join(" ") + "\n");
  const started = await startSandbox({ quiet: true, waitForCovers: true });
  if (!started.ok) fail(`the box is at its sandbox cap (${started.live}/${started.max} live); try again when one ends`, 4);
  const s = started.sandbox;
  await recordOperatorSandbox({
    orgId: s.orgId,
    slug: s.slug,
    operatorUserId: who.id,
    operatorEmail: who.email,
    reason: AGENT_PREFIX + reason,
    expiresAt: s.expiresAt,
  });
  out(
    JSON.stringify({
      link: `${base.replace(/\/+$/, "")}/t/${s.token}${start ? `?to=${start}` : ""}`,
      slug: s.slug,
      expires_at: s.expiresAt.toISOString(),
      operator: who.email,
    }) + "\n",
  );
}

async function log(): Promise<void> {
  out(JSON.stringify({ sandboxes: await operatorSandboxLog() }, null, 2) + "\n");
}

const cmd = process.argv[2];
const run = { mint, log }[cmd ?? ""];
if (!run) fail("usage: try-sandbox.js <mint|log> ...");
run()
  .then(() => process.exit(0))
  .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
