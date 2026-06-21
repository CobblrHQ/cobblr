// Configurable print-update rules — the "post a photo + status to Discord as the
// print runs" flow (the OctoEverywhere experience), but fully user-defined:
//
//   destination (a Discord channel)  ×  scope (a printer / class / all)
//     ×  cadence (stackable "every N %/min/layers", whichever-comes-first, with an
//        optional "no more than once every N min" cap)
//     ×  message (a {{param}} template → a rich Discord embed + the live photo)
//
// The engine runs off LIVE TELEMETRY (evaluatePrintRules is called from the pump
// on every status write), so prints started on the machine are covered — not just
// jobs queued through Cobblr.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { bambuLanDriverFor } from "./jobs-core.js";

export type Cadence = { type: "percent" | "minutes" | "layers"; every: number };
export type RuleEvents = { started?: boolean; progress?: boolean; completed?: boolean; failed?: boolean };
export type RuleMessage = { title?: string; body?: string; photo?: boolean };
export type PrintEvent = "started" | "progress" | "completed" | "failed";
// A pre/post hook step: run a printer control (e.g. chamber light on) or wait.
// Lets a rule light the chamber, settle, shoot the photo, then turn it off.
export type RuleStep = { control: string; params?: Record<string, unknown> } | { wait_ms: number };
export interface RuleHooks {
  pre?: RuleStep[];
  post?: RuleStep[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(60_000, Math.max(0, ms))));

/** Run a hook sequence on a printer (best-effort). A control runs via the LAN
 *  driver (light/pause/…); a wait pauses. Caps each wait at 60s. */
async function runSteps(orgId: string, connectionId: string, serial: string, steps: RuleStep[]): Promise<void> {
  for (const s of steps) {
    if ("wait_ms" in s) { await sleep(s.wait_ms); continue; }
    try {
      const driver = await bambuLanDriverFor(orgId, connectionId, serial);
      if (driver?.runControl) await driver.runControl(serial, s.control, s.params ?? {});
    } catch {
      /* a hook step failing never blocks the rest */
    }
  }
}

// ── The default template (≈ the OctoEverywhere card) — used when a rule leaves a
//    field blank, so it works with zero setup. {{param}} list is in buildParams. ──
export const DEFAULT_TITLE = "{{printer}} · Print {{event}}";
export const DEFAULT_BODY =
  "**{{model}}**\nProgress · {{percent}}\nRemaining · {{remaining}}\nElapsed · {{elapsed}}";

const COLOR: Record<PrintEvent, number> = {
  started: 0x5865f2, // blurple
  progress: 0x4f86c6, // blue
  completed: 0x2ecc71, // green
  failed: 0xe74c3c, // red
};
const EVENT_LABEL: Record<PrintEvent, string> = {
  started: "started",
  progress: "progress",
  completed: "complete",
  failed: "failed",
};

/** `{{param}}` substitution. A line whose only dynamic content resolves empty is
 *  DROPPED (so "Remaining · " never litters the message when a printer doesn't
 *  report that field); a static line, or one with at least one filled param, is
 *  kept. */
export function renderTemplate(tpl: string, params: Record<string, string>): string {
  return tpl
    .split("\n")
    .filter((line) => {
      const refs = [...line.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!);
      if (refs.length === 0) return true; // static line — keep
      return refs.some((k) => params[k] != null && params[k] !== ""); // keep if any ref has a value
    })
    .map((line) => line.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => params[k] ?? ""))
    .join("\n")
    .trim();
}

function fmtDur(min?: number | null): string {
  if (min == null || min < 0) return "";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Telemetry distilled into the values a template can reference. */
export interface PrintFacts {
  printer: string;
  model: string | null;
  event: PrintEvent;
  percent: number | null; // 0..100
  remaining_min: number | null;
  elapsed_min: number | null;
  layer: number | null;
  total_layers: number | null;
  nozzle: number | null;
  bed: number | null;
}

export function buildParams(f: PrintFacts): Record<string, string> {
  const p: Record<string, string> = {
    printer: f.printer,
    event: EVENT_LABEL[f.event],
    model: f.model ?? "",
    percent: f.percent != null ? `${Math.round(f.percent)}%` : "",
    remaining: fmtDur(f.remaining_min),
    elapsed: fmtDur(f.elapsed_min),
    layer: f.layer != null ? String(f.layer) : "",
    total_layers: f.total_layers != null ? String(f.total_layers) : "",
    nozzle: f.nozzle != null ? `${Math.round(f.nozzle)}°` : "",
    bed: f.bed != null ? `${Math.round(f.bed)}°` : "",
  };
  // {{eta}} = wall-clock finish time, server TZ.
  if (f.remaining_min != null && f.remaining_min >= 0) {
    const eta = new Date(Date.now() + f.remaining_min * 60_000);
    p.eta = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else {
    p.eta = "";
  }
  return p;
}

/** Post a rich embed (+ optional photo, uploaded as an attachment so a LAN camera
 *  with no public URL still shows) to a Discord webhook. SSRF-locked to Discord. */
export async function postDiscord(
  webhookUrl: string,
  o: { title: string; body: string; event: PrintEvent; photo?: Buffer | null },
): Promise<void> {
  if (
    !webhookUrl.startsWith("https://discord.com/api/webhooks/") &&
    !webhookUrl.startsWith("https://discordapp.com/api/webhooks/")
  ) {
    throw new Error("discord: webhook must be a https://discord.com/api/webhooks/ address");
  }
  const embed: Record<string, unknown> = {
    title: o.title.slice(0, 256),
    description: o.body.slice(0, 4096),
    color: COLOR[o.event],
  };
  if (o.photo && o.photo.length) embed.image = { url: "attachment://frame.jpg" };

  if (o.photo && o.photo.length) {
    // multipart: payload_json + the frame as files[0], referenced by the embed.
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ embeds: [embed] }));
    form.append("files[0]", new Blob([new Uint8Array(o.photo)], { type: "image/jpeg" }), "frame.jpg");
    const res = await fetch(webhookUrl, { method: "POST", body: form });
    if (!res.ok) throw new Error(`discord: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return;
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) throw new Error(`discord: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

// ── Cadence ────────────────────────────────────────────────────────────────────
/** Does any stacked cadence condition cross since the last fire (whichever-comes-
 *  first / OR), and is the "no more than once per cap" floor satisfied? */
export function cadenceDue(
  cadence: Cadence[],
  cap_minutes: number | null,
  prev: { last_percent: number | null; last_layer: number | null; last_fire_at: Date | null },
  cur: { percent: number | null; layer: number | null; now: number },
): boolean {
  // Cap floor — never more than once per cap_minutes.
  if (cap_minutes != null && prev.last_fire_at && cur.now - prev.last_fire_at.getTime() < cap_minutes * 60_000) {
    return false;
  }
  for (const c of cadence) {
    if (c.every <= 0) continue;
    if (c.type === "percent" && cur.percent != null && cur.percent >= (prev.last_percent ?? 0) + c.every) return true;
    if (c.type === "layers" && cur.layer != null && cur.layer >= (prev.last_layer ?? 0) + c.every) return true;
    if (c.type === "minutes" && prev.last_fire_at && cur.now - prev.last_fire_at.getTime() >= c.every * 60_000) return true;
  }
  return false;
}

/** Best-effort live camera frame for a printer (LAN Bambu over the bridge). */
async function grabPhoto(orgId: string, connectionId: string, serial: string): Promise<Buffer | null> {
  try {
    const driver = await bambuLanDriverFor(orgId, connectionId, serial);
    if (!driver?.getCameraFrame) return null;
    return await driver.getCameraFrame();
  } catch {
    return null;
  }
}

/** Render + deliver one rule's message for a printer. */
export async function fireRule(
  orgId: string,
  connectionId: string,
  serial: string,
  channelKind: string,
  creds: Record<string, unknown>,
  message: RuleMessage,
  facts: PrintFacts,
  hooks?: RuleHooks,
): Promise<void> {
  // PRE hook (e.g. chamber light on + settle) runs BEFORE the photo is grabbed.
  if (hooks?.pre?.length) await runSteps(orgId, connectionId, serial, hooks.pre);
  const params = buildParams(facts);
  const title = renderTemplate(message.title || DEFAULT_TITLE, params);
  const body = renderTemplate(message.body || DEFAULT_BODY, params);
  const photo = message.photo !== false ? await grabPhoto(orgId, connectionId, serial) : null;

  if (channelKind === "discord_bot") {
    // PAID tier — delivered by the cloud overlay's managed Cobblr bot. Open core
    // holds no bot token; it hands the rendered message off via the connector
    // seam. In the FREE image no `discord-bot` connector is registered, so this
    // throws and the caller (a try/catch per rule) simply skips it — a bot
    // channel only exists in a workspace whose overlay can fulfil it anyway.
    await platform().integrations.invokeConnector(
      "discord-bot",
      {
        orgId,
        rowId: "",
        credentials: {},
        args: {
          guild_id: String(creds.guild_id ?? ""),
          channel_id: String(creds.channel_id ?? ""),
          brand_name: creds.brand_name ?? null,
          brand_avatar: creds.brand_avatar ?? null,
          title,
          body,
          event: facts.event,
          photo_b64: photo ? photo.toString("base64") : null,
        },
      },
      "deliver",
    );
  } else {
    // FREE tier — post straight to the channel's incoming webhook.
    const webhook = String(creds.webhook_url ?? "");
    if (webhook) await postDiscord(webhook, { title, body, event: facts.event, photo });
  }

  // POST hook (e.g. wait 1s, chamber light off) runs AFTER delivery.
  if (hooks?.post?.length) await runSteps(orgId, connectionId, serial, hooks.post);
}

const PRINTING = new Set(["printing", "paused"]);

/** Map prev/current state to a lifecycle event, or "progress" while running. */
function eventFor(prevState: string | null, state: string | null): PrintEvent | null {
  const now = state ?? "";
  const was = prevState ?? "";
  if (now === "printing" && was !== "printing" && was !== "paused") return "started";
  if (now === "completed" && PRINTING.has(was)) return "completed";
  if (now === "failed" && PRINTING.has(was)) return "failed";
  if (now === "printing") return "progress";
  return null;
}

export interface RuleTelemetry {
  deviceName: string;
  state: string | null; // printing/paused/completed/failed/idle
  prevState: string | null; // state before this update (transition detection)
  percent: number | null; // 0..100
  layer: number | null;
  total_layers: number | null;
  remaining_min: number | null;
  model: string | null;
  nozzle: number | null;
  bed: number | null;
  jobKey: string | null; // identifies the current print session
}

/** Evaluate every print-update rule that covers this printer against one telemetry
 *  tick, and deliver any that fire. Best-effort: a failing rule/channel never
 *  breaks the poll. Call once per printer per poll (the pump does). */
export async function evaluatePrintRules(
  db: Kysely<DigifabDB>,
  orgId: string,
  connectionId: string,
  serial: string,
  t: RuleTelemetry,
): Promise<void> {
  const ev = eventFor(t.prevState, t.state);
  if (!ev) return;

  const rules = await db
    .selectFrom("digifab_print_rules as r")
    .innerJoin("digifab_channels as c", "c.id", "r.channel_id")
    .select([
      "r.id as rule_id", "r.scope_type", "r.scope_value", "r.events", "r.cadence",
      "r.cap_minutes", "r.message", "r.pre_actions", "r.post_actions", "c.credentials_enc", "c.kind as channel_kind",
    ])
    .where("r.enabled", "=", true)
    .where("c.enabled", "=", true)
    .execute()
    .catch(() => []);
  if (!rules.length) return;

  const me = `${connectionId}:${serial}`;
  const now = Date.now();
  // elapsed, estimated from progress + remaining (avoids tracking a session start).
  const elapsed_min =
    t.percent != null && t.percent > 0 && t.percent < 100 && t.remaining_min != null
      ? (t.remaining_min * t.percent) / (100 - t.percent)
      : null;
  const facts: PrintFacts = {
    printer: t.deviceName,
    model: t.model,
    event: ev,
    percent: t.percent,
    remaining_min: t.remaining_min,
    elapsed_min,
    layer: t.layer,
    total_layers: t.total_layers,
    nozzle: t.nozzle,
    bed: t.bed,
  };

  for (const r of rules) {
    try {
      // Scope match: all printers, or this specific printer (tag/family later).
      if (r.scope_type === "printer" && r.scope_value !== me) continue;
      if (r.scope_type === "tag" || r.scope_type === "family") continue; // fast-follow
      const events = (r.events ?? {}) as RuleEvents;
      if (!events[ev]) continue;

      const prev = await db
        .selectFrom("digifab_print_rule_state")
        .select(["job_key", "last_percent", "last_layer", "last_fire_at"])
        .where("rule_id", "=", r.rule_id)
        .where("serial", "=", serial)
        .executeTakeFirst();

      const newJob = !prev || prev.job_key !== t.jobKey;
      // Progress events are cadence-gated; lifecycle events (started/completed/
      // failed) fire once on the transition.
      if (ev === "progress") {
        // A brand-new print just baselines the cadence clocks (no immediate ping).
        if (newJob) {
          await upsertState(db, r.rule_id, serial, { job_key: t.jobKey, last_percent: t.percent ?? 0, last_layer: t.layer ?? 0, last_fire_at: new Date(now) });
          continue;
        }
        const due = cadenceDue(
          (r.cadence ?? []) as Cadence[],
          r.cap_minutes,
          { last_percent: prev.last_percent, last_layer: prev.last_layer, last_fire_at: prev.last_fire_at },
          { percent: t.percent, layer: t.layer, now },
        );
        if (!due) continue;
      }

      const creds = await platform().integrations.decryptCredentials(orgId, r.credentials_enc);
      const kind = String(r.channel_kind ?? "discord");
      if (kind !== "discord_bot" && !creds.webhook_url) continue; // webhook channel with no URL

      // Advance the cadence/cap state NOW (so the next poll won't re-fire), then
      // fire DETACHED — the pre/post hook delays (light settle, etc.) must never
      // block the telemetry poll.
      await upsertState(db, r.rule_id, serial, {
        job_key: t.jobKey,
        last_percent: t.percent ?? prev?.last_percent ?? 0,
        last_layer: t.layer ?? prev?.last_layer ?? 0,
        last_fire_at: new Date(now),
      });
      const hooks: RuleHooks = { pre: (r.pre_actions ?? []) as RuleStep[], post: (r.post_actions ?? []) as RuleStep[] };
      void fireRule(orgId, connectionId, serial, kind, creds, (r.message ?? {}) as RuleMessage, facts, hooks).catch(() => {});
    } catch {
      /* one rule/channel failing never breaks the poll */
    }
  }
}

async function upsertState(
  db: Kysely<DigifabDB>,
  rule_id: string,
  serial: string,
  v: { job_key: string | null; last_percent: number | null; last_layer: number | null; last_fire_at: Date | null },
): Promise<void> {
  await db
    .insertInto("digifab_print_rule_state")
    .values({ rule_id, serial, ...v })
    .onConflict((oc) => oc.columns(["rule_id", "serial"]).doUpdateSet(v))
    .execute()
    .catch(() => {});
}
