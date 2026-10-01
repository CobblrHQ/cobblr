#!/usr/bin/env tsx
/**
 * lint:notification-channels-parity — the server's channels and the settings
 * page's channels are the same list.
 *
 * `discord_dm` shipped as a working server channel and was never added to the
 * web union, so the settings page could not represent it, could not offer it,
 * and a person who wanted DMs had no way to ask for them. Nothing failed: the
 * page rendered, the other channels worked, and the missing one was simply
 * absent. It went unnoticed until someone asked why a notification never
 * arrived on Discord.
 *
 * Two lists that must agree, in two languages, with no type shared between
 * them. That is the shape a lint is for. The one exception is a channel whose
 * adapter declares `notOffered` (browser push, a stub that sends nothing): it
 * must be ABSENT from the page, because offering it saved a binding that
 * never delivered.
 *
 * Run: npx tsx scripts/lint-notification-channels-parity.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** The union members declared for a named type, from a `| "x"` list. */
function unionOf(file: string, typeName: string): Set<string> {
  const src = readFileSync(join(ROOT, file), "utf8");
  const at = src.indexOf(`export type ${typeName} =`);
  if (at < 0) {
    console.error(`❌ ${file}: no \`export type ${typeName}\` — this lint is keyed to it.`);
    process.exit(1);
  }
  const body = src.slice(at, src.indexOf(";", at));
  return new Set([...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
}

const server = unionOf("api/src/db/schema.ts", "NotificationChannel");
const web = unionOf("web/src/lib/api.ts", "NotificationChannelName");

/** Channels the settings page can actually offer, from its spec table. */
const page = new Set(
  [...readFileSync(join(ROOT, "web/src/pages/MeNotificationChannelsPage.tsx"), "utf8")
    .matchAll(/channel:\s*"([a-z_]+)"/g)].map((m) => m[1]!),
);

/** Channels whose adapter says it delivers nothing (`notOffered: "<why>"`, a
 *  stub such as browser push): the page must NOT offer these, since a binding
 *  to one sends nothing. */
const CHANNELS_DIR = join(ROOT, "api/src/platform/channels");
const notOffered = new Set<string>();
for (const f of readdirSync(CHANNELS_DIR)) {
  if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
  const src = readFileSync(join(CHANNELS_DIR, f), "utf8");
  const name = src.match(/\bname:\s*"([a-z_]+)"/)?.[1];
  if (name && /\bnotOffered:\s*["'`]/.test(src)) notOffered.add(name);
}

const missingFromWeb = [...server].filter((c) => !web.has(c));
const extraInWeb = [...web].filter((c) => !server.has(c));
const unofferable = [...server].filter((c) => !page.has(c) && !notOffered.has(c));
const offeredDead = [...page].filter((c) => notOffered.has(c));

const problems: string[] = [];
if (missingFromWeb.length) {
  problems.push(
    `  web/src/lib/api.ts is missing: ${missingFromWeb.join(", ")}\n` +
      `      The server can deliver on these and the UI cannot name them.`,
  );
}
if (extraInWeb.length) {
  problems.push(
    `  web/src/lib/api.ts invents: ${extraInWeb.join(", ")}\n` +
      `      Nothing delivers these; offering them creates a dead subscription.`,
  );
}
if (unofferable.length) {
  problems.push(
    `  the settings page cannot offer: ${unofferable.join(", ")}\n` +
      `      A channel absent from CHANNEL_SPECS cannot be chosen by anyone.`,
  );
}

if (offeredDead.length) {
  problems.push(
    `  the settings page offers a channel that delivers nothing: ${offeredDead.join(", ")}\n` +
      `      Its adapter says notOffered; a binding to it would never send.`,
  );
}

if (problems.length) {
  console.error("❌ notification channels have drifted:\n");
  console.error(problems.join("\n\n"));
  console.error(
    "\nA channel that exists on the server and not in the UI is invisible rather than\n" +
      "broken, which is why this needs checking instead of noticing.",
  );
  process.exit(1);
}
console.log(`notification-channels-parity: clean (${server.size} channels, ${notOffered.size} not offered)`);
