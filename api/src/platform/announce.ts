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
  /** Decimal embed color. */
  color?: number;
}

function defaultWebhook(): string {
  return process.env.COBBLR_FEEDBACK_DISCORD_WEBHOOK || "";
}

/** Resolve a category's effective settings, applying registry defaults for any
 *  category the admin hasn't touched yet. */
async function settingsFor(category: string): Promise<{ enabled: boolean; webhook: string }> {
  const row = await meta
    .selectFrom("platform_announce_settings")
    .select(["enabled", "webhook_url"])
    .where("category", "=", category)
    .executeTakeFirst();
  const known = KNOWN.get(category);
  const enabled = row ? row.enabled : (known?.defaultEnabled ?? false);
  const webhook = (row?.webhook_url || defaultWebhook()).trim();
  return { enabled, webhook };
}

/** Post a categorized announcement to Discord. Fire-and-forget: returns
 *  immediately; never throws. No-ops when the category is disabled or no
 *  webhook is configured. */
export async function announce(category: string, payload: AnnouncePayload): Promise<void> {
  let cfg: { enabled: boolean; webhook: string };
  try {
    cfg = await settingsFor(category);
  } catch (err) {
    console.error(`[announce] settings lookup failed for ${category}:`, err);
    return;
  }
  if (!cfg.enabled || !cfg.webhook) return;
  void fetch(cfg.webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: payload.title.slice(0, 256),
          description: payload.body ? payload.body.slice(0, 4000) : undefined,
          color: payload.color,
          fields: payload.fields?.slice(0, 10),
        },
      ],
    }),
  }).catch(() => {
    /* Discord down / bad webhook — the underlying event already happened; ignore. */
  });
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
