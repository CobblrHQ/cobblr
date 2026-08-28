// Platform announcements → Discord. A small categorized router so noteworthy
// platform events (feedback resolved, a bundle release, a feature update) post
// to a Discord channel — each category independently toggleable from the
// super-admin UI, so a category can be silenced if it doubles up with, say, a
// separate git-commit feed.
//
// Generalizes the old single-purpose feedback ping. Per category we store
// { enabled, webhook_url }; webhook_url NULL falls back to the default channel
// (COBBLR_FEEDBACK_DISCORD_WEBHOOK). Posting is fire-and-forget — an event is
// never blocked or failed by Discord being down.

import { meta } from "../db/meta.js";
import { read as readFile } from "./files.js";
import { announceWebhookUrl } from "./announce-url.js";
import { routeForGuild } from "./announce-routes.js";

/** Known announcement categories + their human labels (for the config UI).
 *  Adding a category here makes it appear in the super-admin toggle list;
 *  call announce("<key>", …) wherever the event fires. */
// Each entry registers a toggle (+ optional per-category channel) in the super-
// admin UI. `feedback.*` fire automatically from their event sites; `bundle.
// release` + `platform.update` are curated — fired from the "Post an update"
// composer (there's no runtime bundle-publish event: bundles install per-
// workspace and featured bundles ship in-code at deploy, so announcing what's
// noteworthy is a human call, not an auto-trigger).
export const ANNOUNCE_CATEGORIES: Array<{ key: string; label: string; description: string; defaultEnabled: boolean; composable?: boolean }> = [
  { key: "feedback.new", label: "New feedback", description: "A user submitted feedback.", defaultEnabled: true },
  { key: "feedback.resolved", label: "Feedback resolved", description: "A super-admin resolved a feedback item.", defaultEnabled: true },
  { key: "bundle.release", label: "Bundle release", description: "A new bundle or noteworthy bundle update (posted from the composer).", defaultEnabled: true, composable: true },
  { key: "platform.update", label: "Platform / feature update", description: "A feature or release note (posted from the composer).", defaultEnabled: true, composable: true },
];

const KNOWN = new Map(ANNOUNCE_CATEGORIES.map((c) => [c.key, c] as const));

export interface AnnouncePayload {
  title: string;
  body?: string;
  /** Discord embed fields (small key/value pairs, e.g. workspace, page). */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** Post INSIDE an existing thread instead of at channel top level. Discord
   *  webhooks take `?thread_id=`, and a thread STARTED FROM A MESSAGE carries
   *  that message's own id — so the public feedback post's `announce_message_id`
   *  doubles as its thread id once the bot has opened one. Falls back to a
   *  top-level post if the thread doesn't exist (see deliver). */
  threadId?: string | null;
  /** Screenshots to render inline — uploaded to the webhook as file attachments
   *  (bytes read server-side via platform files; no public URL needed). */
  images?: Array<{ orgId: string; fileId: string; name?: string }>;
  /** Decimal embed color. */
  color?: number;
  /** The Discord guild this event came FROM, when it came from Discord at all.
   *  Feedback raised in a chat server surfaces in that server; anything with no
   *  origin (the in-app form) takes the default sink, because it carries the
   *  reporter's workspace and email address and a community server is a
   *  different audience from an ops one. See announce-routes.ts. */
  originGuildId?: string | null;
}

function defaultWebhook(): string {
  return process.env.COBBLR_FEEDBACK_DISCORD_WEBHOOK || "";
}

/** One line at boot saying where user feedback GOES.
 *
 *  This is a privacy-relevant routing decision and it is invisible today: a webhook in
 *  the env or one row in `platform_announce_settings` is the difference between "a
 *  report stays between the reporter and the operator" and "a report is posted to a
 *  chat server". An instance serving people the operator does not know (see
 *  `docs/design-decisions/public-cloud-instance.md`) must be the former, and the way
 *  to be sure is to be TOLD at boot rather than to infer it from an unset variable.
 *
 *  Deliberately not a hard check: a self-hosted operator posting their own feedback to
 *  their own Discord is a legitimate setup, and the categories are admin-editable at
 *  runtime, so an assertion would either be wrong or immediately stale. Visible beats
 *  enforced here. Never throws — a boot line is not worth a failed boot. */
export async function logAnnounceRouting(): Promise<void> {
  try {
    const envWebhook = !!defaultWebhook();
    const rows = await meta.selectFrom("platform_announce_settings").select(["enabled", "webhook_url"]).execute();
    const overrides = rows.filter((r) => r.enabled && (r.webhook_url ?? "").trim()).length;
    if (!envWebhook && overrides === 0) {
      console.log(
        "[announce] Discord OFF (no webhook configured) — feedback stays private: it lives in " +
          "/super-admin → Feedback, and a reply reaches the reporter in-app and by email.",
      );
      return;
    }
    console.log(
      `[announce] Discord ON — ${envWebhook ? "COBBLR_FEEDBACK_DISCORD_WEBHOOK set" : "no env webhook"}, ` +
        `${overrides} per-category override(s). New feedback is POSTED to that webhook, so a report ` +
        "leaves this instance. Clear it if this deployment serves people you do not know.",
    );
  } catch (err) {
    console.warn("[announce] could not report the routing:", err instanceof Error ? err.message : err);
  }
}

/** Resolve a category's effective settings, applying registry defaults for any
 *  category the admin hasn't touched yet. */
async function settingsFor(
  category: string,
  originGuildId?: string | null,
): Promise<{ enabled: boolean; webhook: string }> {
  const row = await meta
    .selectFrom("platform_announce_settings")
    .select(["enabled", "webhook_url"])
    .where("category", "=", category)
    .executeTakeFirst();
  const known = KNOWN.get(category);
  const enabled = row ? row.enabled : (known?.defaultEnabled ?? false);
  // Origin wins over the per-category webhook: the category says WHAT this is,
  // the origin says WHOSE it is, and "whose" is the privacy-relevant half.
  const routed = routeForGuild(originGuildId, process.env.COBBLR_FEEDBACK_DISCORD_ROUTES);
  const webhook = (routed || row?.webhook_url || defaultWebhook()).trim();
  return { enabled, webhook };
}

/** Result of a delivery attempt. `messageId`/`channelId` are populated only when
 *  the caller asked to `wait` (a Discord webhook echoes the created message only
 *  with `?wait=true`) — so an event whose post has a lifecycle can remember which
 *  message to react to later. */
export interface AnnounceResult {
  delivered: boolean;
  messageId: string | null;
  channelId: string | null;
}

const MISS: AnnounceResult = { delivered: false, messageId: null, channelId: null };

/** Shared delivery core. `opts.wait` appends `?wait=true` so Discord responds 200
 *  with the created message body (id + channel_id) instead of a bodyless 204. */
async function deliver(category: string, payload: AnnouncePayload, opts?: { wait?: boolean }): Promise<AnnounceResult> {
  let cfg: { enabled: boolean; webhook: string };
  try {
    cfg = await settingsFor(category, payload.originGuildId);
  } catch (err) {
    console.error(`[announce] settings lookup failed for ${category}:`, err);
    return MISS;
  }
  if (!cfg.enabled || !cfg.webhook) return MISS;
  const url = announceWebhookUrl(cfg.webhook, { wait: opts?.wait, threadId: payload.threadId });
  const embed = {
    title: payload.title.slice(0, 256),
    description: payload.body ? payload.body.slice(0, 4000) : undefined,
    color: payload.color,
    fields: payload.fields?.slice(0, 10),
  };

  // With screenshots: upload the bytes to the webhook as file attachments
  // (multipart) — Discord renders image attachments inline, and there's no
  // public URL for the file, so this keeps it server-side. Falls back to a plain
  // embed if none are readable.
  if (payload.images?.length) {
    try {
      const form = new FormData();
      let n = 0;
      for (const img of payload.images.slice(0, 4)) {
        const f = await readFile(img.orgId, img.fileId, "medium");
        if (!f) continue;
        const safe = (img.name || f.filename || `screenshot-${n}.png`).replace(/[^\w.\-]+/g, "_").slice(0, 80);
        form.append(`files[${n}]`, new Blob([f.bytes], { type: f.mimeType || "image/png" }), safe);
        n++;
      }
      if (n > 0) {
        form.append("payload_json", JSON.stringify({ embeds: [embed] }));
        return postToWebhook(url, { method: "POST", body: form }, category);
      }
    } catch (err) {
      console.error(`[announce] image attach failed for ${category}:`, err);
      // fall through to a plain (text-only) post
    }
  }

  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  };
  const sent = await postToWebhook(url, init, category);
  // A thread that was never opened (or was deleted) makes Discord reject the
  // post outright. Losing a resolution card is strictly worse than the channel
  // noise it was meant to avoid, so fall back to a top-level post rather than
  // letting it vanish.
  if (!sent.delivered && payload.threadId) {
    console.warn(`[announce] ${category}: thread ${payload.threadId} unusable - posting at top level`);
    return postToWebhook(announceWebhookUrl(cfg.webhook, { wait: opts?.wait }), init, category);
  }
  return sent;
}

/** Post a categorized announcement to Discord. Never throws. Returns whether it
 *  actually DELIVERED (true) vs no-op'd / failed (false) — event callers
 *  `void announce(...)` and ignore it (non-blocking); the manual composer awaits
 *  it to report a real outcome. Returns false when the category is disabled, no
 *  webhook is configured, or Discord rejected the post. */
export async function announce(category: string, payload: AnnouncePayload): Promise<boolean> {
  return (await deliver(category, payload)).delivered;
}

/** Like `announce`, but asks Discord to echo the created message so the caller
 *  can remember its id/channel and react to it later. Use for events whose post
 *  has a lifecycle — e.g. `feedback.new`, whose post accrues stage-reactions as
 *  the item is worked (see feedback.ts + the support bot's /feedback-stage). */
export async function announceReturningMessage(category: string, payload: AnnouncePayload): Promise<AnnounceResult> {
  return deliver(category, payload, { wait: true });
}

/** POST to a Discord webhook and report whether it actually landed (+ the created
 *  message ref when `?wait=true` was used). `fetch` only rejects on a network
 *  error — a 4xx/5xx (bad/expired webhook, malformed embed, rate-limit) resolves
 *  with `ok:false`, so the old `void fetch().catch()` dropped every Discord
 *  rejection SILENTLY and the composer still reported success. Check the status,
 *  log the body on failure, and return the verdict so callers (the "Post an
 *  update" composer) can surface a real outcome. Still never throws — event
 *  callers `void announce(...)` and ignore the result. */
async function postToWebhook(url: string, init: RequestInit, category: string): Promise<AnnounceResult> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error(`[announce] ${category} webhook POST failed: HTTP ${r.status} ${detail.slice(0, 300)}`);
      return MISS;
    }
    // With ?wait=true Discord returns the created message JSON; without it a 204
    // with no body (json() would throw — tolerated as delivered-without-ref).
    const msg = (await r.json().catch(() => null)) as { id?: string; channel_id?: string } | null;
    return { delivered: true, messageId: msg?.id ?? null, channelId: msg?.channel_id ?? null };
  } catch (err) {
    console.error(`[announce] ${category} webhook POST threw (network):`, err);
    return MISS;
  }
}

// ── super-admin config surface ───────────────────────────────────────────────

export interface AnnounceSettingView {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  /** A custom channel override, or null = use the default channel. */
  webhook_url: string | null;
  /** Whether a default channel is configured at all (so the UI can warn). */
  default_channel_set: boolean;
  /** True if the "Post an update" composer can fire this category. */
  composable: boolean;
}

/** Whether a category may be posted from the manual composer. */
export function isComposable(category: string): boolean {
  return ANNOUNCE_CATEGORIES.some((c) => c.key === category && c.composable === true);
}

/** All categories with their effective enabled/override state, merging the
 *  registry defaults with any saved rows. */
export async function listAnnounceSettings(): Promise<AnnounceSettingView[]> {
  const rows = await meta
    .selectFrom("platform_announce_settings")
    .select(["category", "enabled", "webhook_url"])
    .execute();
  const byKey = new Map(rows.map((r) => [r.category, r] as const));
  const hasDefault = defaultWebhook().trim().length > 0;
  return ANNOUNCE_CATEGORIES.map((c) => {
    const row = byKey.get(c.key);
    return {
      key: c.key,
      label: c.label,
      description: c.description,
      enabled: row ? row.enabled : c.defaultEnabled,
      webhook_url: row?.webhook_url ?? null,
      default_channel_set: hasDefault,
      composable: c.composable === true,
    };
  });
}

/** Upsert one category's toggle / channel override (super-admin only). */
export async function setAnnounceSetting(
  category: string,
  patch: { enabled?: boolean; webhook_url?: string | null },
): Promise<void> {
  if (!KNOWN.has(category)) throw new Error(`unknown announce category: ${category}`);
  const known = KNOWN.get(category)!;
  await meta
    .insertInto("platform_announce_settings")
    .values({
      category,
      enabled: patch.enabled ?? known.defaultEnabled,
      webhook_url: patch.webhook_url ?? null,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("category").doUpdateSet((eb) => ({
        enabled: patch.enabled !== undefined ? patch.enabled : eb.ref("platform_announce_settings.enabled"),
        webhook_url:
          patch.webhook_url !== undefined ? patch.webhook_url : eb.ref("platform_announce_settings.webhook_url"),
        updated_at: new Date(),
      })),
    )
    .execute();
}
