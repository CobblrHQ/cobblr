import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { tenantContext } from "../db.js";
import { esphomeDriver } from "../esphome.js";

export const esphomeRouter = Router({ mergeParams: true });
const Create = z.object({ label: z.string().trim().min(1).max(128), base_url: z.string().url().refine(v => ["http:", "https:"].includes(new URL(v).protocol) && !new URL(v).username && !new URL(v).password), bridge: z.string().max(48).default(""), host: z.string().regex(/^[a-zA-Z0-9._:-]{1,253}$/).optional(), api_key: z.string().max(512).optional() }).strict();
esphomeRouter.get("/", asyncHandler(async (req, res) => {
  const { org } = tenantContext(req);
  res.json({ items: (await platform().devices.connections().list(org.id)).filter(c => c.type === "esphome") });
}));
// AI-REACH: exempt connection credentials are configured by a person with the device in hand
esphomeRouter.post("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const parsed = Create.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const { label, base_url, bridge, host, api_key } = parsed.data;
  const { org } = tenantContext(req);
  const row = await platform().devices.connections().create(org.id, { type: "esphome", label, base_url, config: { bridge, ...(host ? { host } : {}) }, creds: api_key ? { apiKey: api_key } : {} });
  const service = await platform().connections.createWorkspaceConnection({ orgId: org.id, kind: "service", providerId: "adapter:esphome.indicate", label, credentials: { device_connection: row.id, duration: "30" }, originKey: `esphome:${row.id}`, note: "Test this device from Devices before mapping a place's light." });
  res.status(201).json(await platform().devices.connections().update(org.id, row.id, { config: { ...row.config, service_connection: service.credentialId } }));
}));
esphomeRouter.get("/:id/entities", asyncHandler(async (req, res) => {
  const driver = await esphomeDriver(tenantContext(req).org.id, req.params.id as string);
  if (!driver?.listDevices) return res.status(404).json({ error: { code: "not_found", message: "That ESPHome connection is no longer here." } });
  return res.json({ items: await driver.listDevices() });
}));
// AI-REACH: exempt LAN discovery is part of connection setup; Services exposes the connected entities
esphomeRouter.post("/:id/discover", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const driver = await esphomeDriver(tenantContext(req).org.id, req.params.id as string);
  if (!driver?.runCommand) return res.status(404).json({ error: { code: "not_found", message: "That ESPHome connection is no longer here." } });
  return res.json({ items: (await driver.runCommand("discover", {})).data?.devices ?? [] });
}));
// AI-REACH: exempt chooses the host for a credential-bearing device connection
esphomeRouter.patch("/:id", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const parsed = z.object({ host: z.string().regex(/^[a-zA-Z0-9._:-]{1,253}$/) }).strict().safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const { org } = tenantContext(req);
  const existing = await platform().devices.connections().get(org.id, req.params.id as string);
  if (!existing || existing.type !== "esphome") return res.status(404).json({ error: { code: "not_found", message: "That ESPHome connection is no longer here." } });
  return res.json(await platform().devices.connections().update(org.id, existing.id, { config: { ...existing.config, host: parsed.data.host } }));
}));
// AI-REACH: exempt disconnecting hardware is a connection setup operation
esphomeRouter.delete("/:id", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const { org } = tenantContext(req);
  const existing = await platform().devices.connections().get(org.id, req.params.id as string);
  if (!existing || existing.type !== "esphome") return res.status(404).json({ error: { code: "not_found", message: "That ESPHome connection is no longer here." } });
  await platform().devices.connections().remove(org.id, existing.id);
  return res.json({ ok: true });
}));
