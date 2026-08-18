// /api/v1/orgs/:slug/modules/digifab/print-rules —
// The configurable "post print updates to Discord" feature, in two layers:
//   /channels  — destinations (a Discord channel = its webhook, encrypted),
//                defined once and referenced by many rules.
//   /rules     — map a scope (printer / all) → channel → cadence → message.
// A channel's webhook is never returned; only its label/kind/enabled.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { DEFAULT_TITLE, DEFAULT_BODY, buildParams, renderTemplate, postDiscord, fireRule, type PrintFacts, type RuleMessage, type RuleStep } from "../print-rules.js";

export const printRulesRouter = Router({ mergeParams: true });

const DISCORD_WEBHOOK = z.string().url().regex(/^https:\/\/discord(app)?\.com\/api\/webhooks\//, {
  message: "must be a https://discord.com/api/webhooks/... URL",
});

// ── Channels (destinations) ─────────────────────────────────────────────────────
// Two kinds: 'discord' (free — an incoming webhook URL) and 'discord_bot' (paid —
// the managed Cobblr bot posts to a guild+channel, delivered by the cloud overlay;
// the bot token is never stored here, only the routing + branding).
const ChannelCreate = z
  .object({
    label: z.string().min(1).max(80),
    kind: z.enum(["discord", "discord_bot"]).default("discord"),
    webhook_url: DISCORD_WEBHOOK.optional(),
    guild_id: z.string().max(40).optional(),
    channel_id: z.string().max(40).optional(),
    brand_name: z.string().max(80).optional(),
    brand_avatar: z.string().url().max(500).optional(),
  })
  .refine((d) => (d.kind === "discord_bot" ? !!(d.guild_id && d.channel_id) : !!d.webhook_url), {
    message: "discord needs webhook_url; discord_bot needs guild_id + channel_id",
  });
function channelCreds(d: z.infer<typeof ChannelCreate>): Record<string, unknown> {
  return d.kind === "discord_bot"
    ? { guild_id: d.guild_id, channel_id: d.channel_id, brand_name: d.brand_name ?? null, brand_avatar: d.brand_avatar ?? null }
    : { webhook_url: d.webhook_url };
}
const ChannelPatch = z.object({
  label: z.string().min(1).max(80).optional(),
  webhook_url: DISCORD_WEBHOOK.optional(),
  enabled: z.boolean().optional(),
});

printRulesRouter.get(
  "/channels",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("digifab_channels")
      .select(["id", "label", "kind", "enabled", "created_at"])
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: configures a notification channel, which can hold a webhook secret; configuration stays a person's
printRulesRouter.post(
  "/channels",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = ChannelCreate.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const orgId = tenantContext(req).org.id;
    const credentials_enc = await platform().integrations.encryptCredentials(orgId, channelCreds(p.data));
    const row = await tenantDb(req)
      .insertInto("digifab_channels")
      .values({ label: p.data.label, kind: p.data.kind, credentials_enc })
      .returning(["id", "label", "kind", "enabled", "created_at"])
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// AI-REACH: edits a notification channel's config (see POST)
printRulesRouter.patch(
  "/channels/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = ChannelPatch.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const orgId = tenantContext(req).org.id;
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (p.data.label !== undefined) set.label = p.data.label;
    if (p.data.enabled !== undefined) set.enabled = p.data.enabled;
    if (p.data.webhook_url !== undefined) set.credentials_enc = await platform().integrations.encryptCredentials(orgId, { webhook_url: p.data.webhook_url });
    const row = await tenantDb(req)
      .updateTable("digifab_channels")
      .set(set)
      .where("id", "=", req.params.id!)
      .returning(["id", "label", "kind", "enabled", "created_at"])
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "channel not found" } });
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
printRulesRouter.delete(
  "/channels/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req).deleteFrom("digifab_channels").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);

// Send a test post to a channel — confirms the webhook works.
// AI-REACH: drives a device or a preview surface, or is an operator/self-test probe
printRulesRouter.post(
  "/channels/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const ch = await tenantDb(req).selectFrom("digifab_channels").select(["kind", "credentials_enc"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!ch) return void res.status(404).json({ error: { code: "not_found", message: "channel not found" } });
    const creds = await platform().integrations.decryptCredentials(orgId, ch.credentials_enc);
    try {
      if (ch.kind === "discord_bot") {
        // Delivered by the overlay's managed bot (paid). Throws in the free image.
        await platform().integrations.invokeConnector(
          "discord-bot",
          { orgId, rowId: "", credentials: {}, args: { guild_id: String(creds.guild_id ?? ""), channel_id: String(creds.channel_id ?? ""), brand_name: creds.brand_name ?? null, brand_avatar: creds.brand_avatar ?? null, title: "✅ Cobblr, test", body: "Print updates will post here.", event: "completed", photo_b64: null } },
          "deliver",
        );
      } else {
        await postDiscord(String(creds.webhook_url ?? ""), { title: "✅ Cobblr, test", body: "Print updates will post here.", event: "completed", photo: null });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: { code: "delivery_failed", message: (e as Error).message } });
    }
  }),
);

// ── Rules ────────────────────────────────────────────────────────────────────────
const Cadence = z.object({ type: z.enum(["percent", "minutes", "layers"]), every: z.number().positive().max(100000) });
// A hook step: run a control (chamber light on) or wait N ms. Capped lists.
const Step = z.union([
  z.object({ control: z.string().min(1).max(40), params: z.record(z.string(), z.unknown()).optional() }),
  z.object({ wait_ms: z.number().int().min(0).max(60000) }),
]);
const RuleBody = z.object({
  label: z.string().min(1).max(80),
  scope_type: z.enum(["all", "printer", "tag", "family"]).default("all"),
  scope_value: z.string().max(200).nullable().optional(),
  channel_id: z.string().uuid(),
  events: z.object({ started: z.boolean().optional(), progress: z.boolean().optional(), completed: z.boolean().optional(), failed: z.boolean().optional() }).default({ progress: true, completed: true, failed: true }),
  cadence: z.array(Cadence).max(5).default([]),
  cap_minutes: z.number().int().positive().max(1440).nullable().optional(),
  message: z.object({ title: z.string().max(256).optional(), body: z.string().max(2000).optional(), photo: z.boolean().optional() }).default({}),
  pre_actions: z.array(Step).max(8).default([]),
  post_actions: z.array(Step).max(8).default([]),
  enabled: z.boolean().default(true),
});

const RULE_COLS = ["id", "label", "scope_type", "scope_value", "channel_id", "events", "cadence", "cap_minutes", "message", "pre_actions", "post_actions", "enabled", "created_at"] as const;

printRulesRouter.get(
  "/rules",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req).selectFrom("digifab_print_rules").select(RULE_COLS).orderBy("created_at", "desc").execute();
    res.json({ items: rows });
  }),
);

// jsonb columns must be inserted as JSON TEXT — node-postgres serializes a JS
// array as a Postgres array literal (→ "malformed array literal"), not JSON. The
// pump stringifies its `report` for the same reason.
const jb = <T>(v: T): T => JSON.stringify(v) as unknown as T;

// AI-REACH: authors an automation rule; a rule is a small program with side effects the user should read before enabling
printRulesRouter.post(
  "/rules",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = RuleBody.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const row = await tenantDb(req)
      .insertInto("digifab_print_rules")
      .values({
        label: p.data.label, scope_type: p.data.scope_type, scope_value: p.data.scope_value ?? null,
        channel_id: p.data.channel_id, events: jb(p.data.events), cadence: jb(p.data.cadence),
        cap_minutes: p.data.cap_minutes ?? null, message: jb(p.data.message),
        pre_actions: jb(p.data.pre_actions), post_actions: jb(p.data.post_actions), enabled: p.data.enabled,
      })
      .returning(RULE_COLS)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// AI-REACH: edits an automation rule (see POST)
printRulesRouter.patch(
  "/rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = RuleBody.partial().safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const set: Record<string, unknown> = { updated_at: new Date() };
    const JSONB = new Set(["events", "cadence", "message", "pre_actions", "post_actions"]);
    for (const k of ["label", "scope_type", "scope_value", "channel_id", "events", "cadence", "cap_minutes", "message", "pre_actions", "post_actions", "enabled"] as const) {
      if (p.data[k] !== undefined) set[k] = JSONB.has(k) ? jb(p.data[k]) : p.data[k];
    }
    const row = await tenantDb(req).updateTable("digifab_print_rules").set(set).where("id", "=", req.params.id!).returning(RULE_COLS).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "rule not found" } });
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
printRulesRouter.delete(
  "/rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req).deleteFrom("digifab_print_rules").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);

// Preview the rendered message from a template (no delivery) — drives the live
// editor preview. Uses sample facts so the user sees the shape immediately.
const SAMPLE: PrintFacts = {
  printer: "Bambi", model: "Cherry Blossom Crossbody Bag", event: "progress",
  percent: 90, remaining_min: 13, elapsed_min: 117, layer: 184, total_layers: 205, nozzle: 220, bed: 65,
};
// AI-REACH: drives a device or a preview surface, or is an operator/self-test probe
printRulesRouter.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const p = z.object({ title: z.string().max(256).optional(), body: z.string().max(2000).optional() }).safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const params = buildParams(SAMPLE);
    res.json({ title: renderTemplate(p.data.title || DEFAULT_TITLE, params), body: renderTemplate(p.data.body || DEFAULT_BODY, params) });
  }),
);

// Fire a REAL update right now — render this rule's template against the printer's
// CURRENT live telemetry (+ grab the live photo) and post it to the channel. Lets
// you verify the whole rule end-to-end without waiting for a cadence boundary.
const TestFire = z.object({
  channel_id: z.string().uuid(),
  message: z.object({ title: z.string().max(256).optional(), body: z.string().max(2000).optional(), photo: z.boolean().optional() }).optional(),
  scope_type: z.enum(["all", "printer", "tag", "family"]).optional(),
  scope_value: z.string().max(200).nullable().optional(),
  pre_actions: z.array(Step).max(8).optional(),
  post_actions: z.array(Step).max(8).optional(),
});
// AI-REACH: drives a device or a preview surface, or is an operator/self-test probe
printRulesRouter.post(
  "/test-fire",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);
    const p = TestFire.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const ch = await db.selectFrom("digifab_channels").select(["kind", "credentials_enc"]).where("id", "=", p.data.channel_id).executeTakeFirst();
    if (!ch) return void res.status(404).json({ error: { code: "not_found", message: "channel not found" } });

    // Resolve a printer: the scoped one, else the most-recently-updated (the
    // active printer for a test).
    let connId: string | undefined;
    let serial: string | undefined;
    if (p.data.scope_type === "printer" && p.data.scope_value) {
      const i = p.data.scope_value.indexOf(":");
      if (i > 0) { connId = p.data.scope_value.slice(0, i); serial = p.data.scope_value.slice(i + 1); }
    }
    const row = await db
      .selectFrom("digifab_bambu_status")
      .select(["connection_id", "serial", "progress", "remaining_min", "layer_num", "total_layers", "nozzle_actual", "bed_actual", "report"])
      .$if(!!(connId && serial), (q) => q.where("connection_id", "=", connId!).where("serial", "=", serial!))
      .orderBy("updated_at", "desc")
      .executeTakeFirst();
    if (!row) return void res.status(409).json({ error: { code: "no_telemetry", message: "no live printer telemetry to test with. Start a print or open the printer first" } });
    connId = row.connection_id;
    serial = row.serial;

    const link = await db.selectFrom("digifab_device_links").select(["remote_device_name", "machine_label"]).where("connection_id", "=", connId).where("remote_device_id", "=", serial).executeTakeFirst();
    const deviceName = link?.machine_label || link?.remote_device_name || serial;
    const rep = (row.report ?? {}) as Record<string, unknown>;
    const model =
      (typeof rep.subtask_name === "string" && rep.subtask_name.trim()) ||
      (typeof rep.gcode_file === "string" ? rep.gcode_file.replace(/^.*[\\/]/, "").replace(/\.(gcode|3mf)(\.\w+)?$/i, "").trim() : "") ||
      null;
    const pct = row.progress;
    const elapsed = pct != null && pct > 0 && pct < 100 && row.remaining_min != null ? (row.remaining_min * pct) / (100 - pct) : null;
    const facts: PrintFacts = {
      printer: deviceName, model, event: "progress",
      percent: pct, remaining_min: row.remaining_min, elapsed_min: elapsed,
      layer: row.layer_num, total_layers: row.total_layers, nozzle: row.nozzle_actual, bed: row.bed_actual,
    };

    const creds = await platform().integrations.decryptCredentials(orgId, ch.credentials_enc);
    try {
      await fireRule(orgId, connId, serial, ch.kind, creds, (p.data.message ?? {}) as RuleMessage, facts, {
        pre: (p.data.pre_actions ?? []) as RuleStep[],
        post: (p.data.post_actions ?? []) as RuleStep[],
      });
      res.json({ ok: true, printer: deviceName });
    } catch (e) {
      res.status(502).json({ error: { code: "delivery_failed", message: (e as Error).message } });
    }
  }),
);
