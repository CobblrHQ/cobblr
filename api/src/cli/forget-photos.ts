// A person asked for their kept item photos to be deleted: the data-request
// path the terms name (CobblrHQ/core#3769), run by an operator from the box.
//
//   node dist/cli/forget-photos.js --user <email|uuid>
//
// It queues a `forget` for the account (photo-retention.ts) and sends it at
// once. The shared network then deletes every photo still linked to the
// person, bytes and all. A photo already unlinked (past two years, or after
// the account was deleted) carries no person, so no request can reach it,
// and this says so rather than claiming a deletion.
//
// Runs INSIDE the api container (docker exec), like view-as: it needs the
// install's signing secret to recompute the actor id, and never prints it.

import { writeSync } from "node:fs";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { photoRetentionTarget } from "@cobblr/platform-contract/photo-retention";
import { photoRetentionRound, queuePhotoRetention } from "../platform/photo-retention.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function done(text: string, code = 0): never {
  writeSync(code ? 2 : 1, `forget-photos: ${text}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const who = arg("user")?.trim();
  if (!who) done("usage: forget-photos --user <email|uuid>", 2);
  const byId = /^[0-9a-f-]{36}$/i.test(who);
  const found = await sql<{ id: string }>`
    select id from users where ${byId ? sql`id = ${who}::uuid` : sql`lower(email) = lower(${who})`} and deleted_at is null
  `.execute(meta);
  const userId = found.rows[0]?.id;
  if (!userId) done("no such live account. A deleted account's photos were already unlinked: nothing can trace them to anyone.", 1);
  if (!photoRetentionTarget()) done("this install reaches no photo network, so it can have kept no photo.", 1);
  if (!(await queuePhotoRetention("forget", userId))) done("this account never accepted the photo terms, so it can have sent no photo. Nothing to delete.");
  const r = await photoRetentionRound();
  if (r.failed) done("queued; the network did not answer yet, and the sweeper will keep trying every few minutes until it does.");
  done("the network deleted every photo still linked to this person.");
}

main().catch((err) => done((err as Error).message, 1));
