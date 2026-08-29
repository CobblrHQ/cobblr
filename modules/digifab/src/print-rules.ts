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
import { sql, type Kysely } from "kysely";
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

/**
 * Map prev/current state to a lifecycle event, or "progress" while running.
 *
 * A lifecycle event is a TRANSITION, so it needs two states to compare. With no
 * previous state there is nothing to transition FROM, and a printer that is
 * already printing the first time we look at it has not just started — we have
 * just arrived. Saying "Print started" there is a lie told confidently, and it
 * is the one people notice: an api restart mid-print announced a new print at
 * 43% and again at 49% (2026-08-29, right after a promote and a canary roll).
 *
 * So an unknown previous state yields "progress" (cadence-gated, and silent on
 * a fresh cadence baseline) rather than "started". The cost is a genuinely new
 * print going unannounced when its very first report is the one that starts it
 * — which can only happen for a printer we have never persisted a state for,
 * since the pump reads the last state back from the database.
 */
export function eventFor(prevState: string | null, state: string | null): PrintEvent | null {
  const now = state ?? "";
  const was = prevState ?? "";
  if (now === "printing" && was && was !== "printing" && was !== "paused") return "started";
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
          // `fired: []` re-arms started/completed/failed for the new print —
          // without it the previous print's announcements would suppress this
          // one's.
          await upsertState(db, r.rule_id, serial, { job_key: t.jobKey, last_percent: t.percent ?? 0, last_layer: t.layer ?? 0, last_fire_at: new Date(now), fired: [] });
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

      // A LIFECYCLE event is claimed per (rule, printer, print, event) — not
      // per moment. `claimFire` below compares against the row THIS process
      // just read, which stops two processes racing on the same read but not
      // the same transition seen a few seconds apart: prod announced the print
      // finishing, the canary saw the same finish on its own next tick, read
      // the row fresh, matched its own read, and announced it again. Progress
      // hid the problem because the cadence cap suppressed the second process;
      // started/completed/failed skip the cadence entirely, so they doubled
      // (reported 2026-08-29, after the concurrent-race fix had already landed).
      if (ev !== "progress") {
        const claimedEvent = await claimLifecycle(db, r.rule_id, serial, t.jobKey, ev, {
          last_percent: t.percent ?? prev?.last_percent ?? 0,
          last_layer: t.layer ?? prev?.last_layer ?? 0,
          last_fire_at: new Date(now),
        });
        if (!claimedEvent) continue; // already announced for this print
      }

      const creds = await platform().integrations.decryptCredentials(orgId, r.credentials_enc);
      const kind = String(r.channel_kind ?? "discord");
      if (kind !== "discord_bot" && !creds.webhook_url) continue; // webhook channel with no URL

      // CLAIM the cadence slot before firing. The write advances the state so
      // this process's next poll won't re-fire — but it is also what stops a
      // SECOND process from firing the same slot at all, which is the whole
      // reason it is a conditional update rather than an upsert.
      //
      // Every api process runs its own telemetry pump, and more than one api
      // now runs against a single database (the canary channel, and briefly a
      // rolling deploy). Both pumps read the same `prev`, both find the cadence
      // due, and both used to write and post: a workspace's printer posted its
      // progress to Discord twice, every time, for weeks (2026-08-29). Only the
      // process whose UPDATE actually matched the row it read may post.
      if (ev === "progress") {
        const claimed = await claimFire(db, r.rule_id, serial, prev ?? null, {
          job_key: t.jobKey,
          last_percent: t.percent ?? prev?.last_percent ?? 0,
          last_layer: t.layer ?? prev?.last_layer ?? 0,
          last_fire_at: new Date(now),
        });
        if (!claimed) continue; // another process got this slot — it is posting
      }
      // Say what went out, and from which process. A duplicate card was
      // diagnosed twice from reasoning alone because nothing recorded a fire;
      // one line makes the next one readable straight off the box.
      console.log(`[digifab] print-rule ${r.rule_id} → ${ev} for ${serial} (${t.percent ?? "?"}%)`);
      // Fire DETACHED — the pre/post hook delays (light settle, etc.) must
      // never block the telemetry poll.
      const hooks: RuleHooks = { pre: (r.pre_actions ?? []) as RuleStep[], post: (r.post_actions ?? []) as RuleStep[] };
      void fireRule(orgId, connectionId, serial, kind, creds, (r.message ?? {}) as RuleMessage, facts, hooks).catch(() => {});
    } catch {
      /* one rule/channel failing never breaks the poll */
    }
  }
}

/**
 * Take the next fire slot for (rule, printer), or report that somebody else
 * already has it. Returns true ONLY to the caller whose write landed.
 *
 * `prev` is the state row this decision was made from. The UPDATE re-states it
 * as a WHERE, so it matches only while the row is still the one that was read
 * (compare-and-set); a racing process finds 0 rows and does not post. When
 * there was no row, the INSERT itself is the claim and the loser conflicts.
 *
 * `is not distinct from` rather than `=`, because a fresh row's last_fire_at
 * can be null and `null = null` is null, which would match nothing and wedge
 * the rule permanently.
 */
export async function claimFire(
  db: Kysely<DigifabDB>,
  rule_id: string,
  serial: string,
  prev: { job_key: string | null; last_percent: number | null; last_layer: number | null; last_fire_at: Date | null } | null,
  next: { job_key: string | null; last_percent: number | null; last_layer: number | null; last_fire_at: Date | null },
): Promise<boolean> {
  if (!prev) {
    const inserted = await db
      .insertInto("digifab_print_rule_state")
      .values({ rule_id, serial, ...next })
      .onConflict((oc) => oc.columns(["rule_id", "serial"]).doNothing())
      .returning("rule_id")
      .executeTakeFirst()
      .catch(() => undefined);
    return !!inserted;
  }
  const won = await db
    .updateTable("digifab_print_rule_state")
    .set(next)
    .where("rule_id", "=", rule_id)
    .where("serial", "=", serial)
    .where(sql<boolean>`last_fire_at is not distinct from ${prev.last_fire_at}`)
    .where(sql<boolean>`job_key is not distinct from ${prev.job_key}`)
    .returning("rule_id")
    .executeTakeFirst()
    .catch(() => undefined);
  return !!won;
}

/**
 * Announce a lifecycle event ONCE for this print, whichever process gets there
 * first. Returns true only to the caller whose write landed.
 *
 * One statement, so the check and the record cannot be split by a second
 * process arriving between them. The DO UPDATE's own WHERE is the guard: it
 * matches when the print has changed (a new print re-arms every event) or when
 * this event is not already in `fired`. An unchanged print whose event is
 * recorded updates no row, and the caller stays quiet.
 */
export async function claimLifecycle(
  db: Kysely<DigifabDB>,
  rule_id: string,
  serial: string,
  job_key: string | null,
  event: PrintEvent,
  v: { last_percent: number | null; last_layer: number | null; last_fire_at: Date | null },
): Promise<boolean> {
  const one = JSON.stringify([event]);
  const rows = await sql<{ rule_id: string }>`
    insert into digifab_print_rule_state
      (rule_id, serial, job_key, last_percent, last_layer, last_fire_at, fired)
    values (${rule_id}, ${serial}, ${job_key}, ${v.last_percent}, ${v.last_layer}, ${v.last_fire_at}, ${one}::jsonb)
    on conflict (rule_id, serial) do update set
      job_key = excluded.job_key,
      last_percent = excluded.last_percent,
      last_layer = excluded.last_layer,
      last_fire_at = excluded.last_fire_at,
      fired = case
        when digifab_print_rule_state.job_key is distinct from excluded.job_key then excluded.fired
        else digifab_print_rule_state.fired || excluded.fired
      end
    where digifab_print_rule_state.job_key is distinct from excluded.job_key
       or not (digifab_print_rule_state.fired @> excluded.fired)
    returning digifab_print_rule_state.rule_id
  `
    .execute(db)
    .catch(() => ({ rows: [] as { rule_id: string }[] }));
  return rows.rows.length > 0;
}

async function upsertState(
  db: Kysely<DigifabDB>,
  rule_id: string,
  serial: string,
  v: { job_key: string | null; last_percent: number | null; last_layer: number | null; last_fire_at: Date | null; fired?: string[] },
): Promise<void> {
  // `fired` is a jsonb ARRAY, so it goes to Postgres as a JSON STRING: node-pg
  // renders a JS array as a Postgres array literal ({}), which jsonb rejects,
  // and this insert swallows its own errors — the write would have failed
  // silently and every print would have kept announcing itself. The column's
  // write type is `string`, so forgetting this is a compile error rather than
  // something lint:jsonb-array-writes has to catch (and it could not have
  // caught it here: the value arrives through a parameter, not as a literal at
  // `.values(`).
  const { fired, ...rest } = v;
  const row = { ...rest, ...(fired === undefined ? {} : { fired: JSON.stringify(fired) }) };
  await db
    .insertInto("digifab_print_rule_state")
    .values({ rule_id, serial, ...row })
    .onConflict((oc) => oc.columns(["rule_id", "serial"]).doUpdateSet(row))
    .execute()
    .catch(() => {});
}
