import { platform, requireActionEntity } from "@cobblr/platform-contract";
import { randomUUID } from "node:crypto";
import { ADAPTER_TRANSIT_PROPERTY, type BuiltInServiceDef, type BuiltInConnectionDef } from "@cobblr/platform-contract/services";
import { IndicateInput, PLACE_INDICATE, PLACE_INDICATE_DECL, PlaceLight, LightGrid, type PlaceLightMapping, type PlaceIndicateInput } from "@cobblr/platform-contract/place-indicate";
import type { Kysely } from "kysely";
import type { CoreLocationsDB } from "./db.js";
import { LightSignals } from "./light-signals.js";
import { mapLightGrid } from "./light-grid.js";

export const LIGHT_EVENTS = ["core-locations.light.shown", "core-locations.light.found", "core-locations.light.picked", "core-locations.light.put-away", "core-locations.light.label-scanned"] as const;
const dbFor = async (org: string) => await platform().tenants.getDb(org) as Kysely<CoreLocationsDB>;
export const lightSignals = new LightSignals({
  place: async (org, id) => (await (await dbFor(org)).selectFrom("core_locations_locations").select(["id", "name", "parent_id", "metadata"]).where("id", "=", id).executeTakeFirst()) ?? null,
  path: async (orgId, ref) => (await platform().placement.pathsOf({ orgId, containees: [ref] })).get(`${ref.kind}:${ref.id}`) ?? [],
  accent: async org => {
    const color = (await platform().orgs.get(org))?.accent;
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#ea580c";
  },
});

function connection(driver: PlaceLightMapping["driver"]): BuiltInConnectionDef {
  if (driver === "esphome") return {
    group: "esphome.indicate", title: "ESPHome", summary: "Use a device from Devices. Native API keys stay on its bridge.",
    config_schema: { type: "object", properties: { device_connection: { type: "string", title: "Device connection id" }, duration: { type: "string", title: "Seconds to stay lit", default: "30" } }, required: ["device_connection"] },
    async test(config, ctx) {
      if (!ctx.orgId) return { ok: true, warning: "Share this connection with the workspace that owns the device, then test a place's light." };
      try {
        const driver = await platform().devices.getDriver(ctx.orgId, config.device_connection ?? "");
        if (!driver?.listDevices) return { ok: false, reason: "unknown", error: "Choose an ESPHome device connection from this workspace." };
        await driver.listDevices();
        return { ok: true, note: "ESPHome answered through its bridge." };
      } catch { return { ok: false, reason: "unreachable", error: "ESPHome did not answer through its bridge." }; }
    },
  };
  const wled = driver === "wled";
  return {
    title: wled ? "WLED" : "Home Assistant",
    summary: wled ? "Light up a bin on an LED strip, directly or through your bridge. Home Assistant is not needed." : "Light up a place with a light managed by Home Assistant.",
    config_schema: { type: "object", properties: {
      base_url: { type: "string", title: "Address", format: "uri" },
      ...(driver !== "home-assistant" ? {} : { token: { type: "string" as const, title: "Long-lived access token", writeOnly: true as const } }),
      duration: { type: "string", title: "Seconds to stay lit", default: "30", description: "From 1 to 300 seconds. Another request turns the previous light off." },
      transit: ADAPTER_TRANSIT_PROPERTY,
    }, required: driver !== "home-assistant" ? ["base_url"] : ["base_url", "token"] },
    async test(config, ctx) {
      const duration = Number(config.duration || "30");
      if (!Number.isInteger(duration) || duration < 1 || duration > 300) return { ok: false, reason: "unknown", error: "Choose a duration from 1 to 300 seconds." };
      if (!ctx.fetch) return { ok: false, reason: "unreachable", error: "Give the address the light answers at." };
      try {
        const res = await ctx.fetch({ path: wled ? "/json/info" : "/api/", timeoutMs: 5000, ...(driver !== "home-assistant" ? {} : { headers: { authorization: `Bearer ${config.token ?? ""}` } }) });
        if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_key", error: "Home Assistant did not accept this token." };
        if (res.status !== 200 || !res.json || (wled && !(res.json as { leds?: unknown }).leds)) return { ok: false, reason: "unknown", error: "That address did not answer like the light service selected." };
        return { ok: true, note: wled ? "WLED answered. Map a place or a grid of bins to its LEDs." : "Home Assistant answered. Choose a light entity in the place's settings." };
      } catch { return { ok: false, reason: "unreachable", error: "The light did not answer. Check its address and your bridge." }; }
    },
  };
}

export const LIGHT_ADAPTERS: BuiltInServiceDef[] = (["wled", "home-assistant", "esphome"] as const).map(driver => ({
  id: `${driver}.indicate`, name: driver === "esphome" ? "ESPHome" : driver === "wled" ? "WLED" : "Home Assistant", connection: connection(driver), capability: PLACE_INDICATE_DECL,
  run: async ctx => {
    if (driver !== "esphome") return { output: await lightSignals.indicate(ctx, ctx.input as PlaceIndicateInput, driver) };
    const device = await platform().devices.getDriver(ctx.orgId, ctx.config?.device_connection ?? "");
    if (!device?.runCommand) throw new Error("Choose an ESPHome device connection from this workspace.");
    return { output: await lightSignals.indicate({ ...ctx, fetch: async request => {
      const body = request.body as { command: string; params: Record<string, unknown> };
      const reply = await device.runCommand!(body.command, body.params);
      return { status: reply.ok ? 200 : 502, headers: {}, bytes: new Uint8Array(), json: reply };
    } }, ctx.input as PlaceIndicateInput, driver) };
  },
}));

export class LightSetupError extends Error {}
export async function savePlaceLight(orgId: string, id: string, raw: unknown, userId: string | null = null): Promise<void> {
  const mapping = raw === null ? null : PlaceLight.parse(raw);
  if (mapping) await requireLightConnection(orgId, mapping.connection_id, mapping.driver);
  const db = await dbFor(orgId);
  const before = await db.selectFrom("core_locations_locations").select("metadata").where("id", "=", id).executeTakeFirst();
  const row = await db.updateTable("core_locations_locations").set({ metadata: platform().db.mergeJsonb("metadata", { light: mapping }) as never, updated_at: new Date() }).where("id", "=", id).returning("id").executeTakeFirst();
  if (!row) throw new LightSetupError("That place is no longer here.");
  await platform().activity.log({ orgId, userId, action: "location_light_updated", ref: { module: "core-locations", entityType: "location", entityId: id }, diff: { light: mapping }, before: { light: before?.metadata.light ?? null } });
  await platform().events.emit("core-locations.location.updated", { orgId, locationId: id });
}

async function requireLightConnection(orgId: string, id: string, driver: PlaceLightMapping["driver"]): Promise<void> {
  const holders = await platform().services.connectionsFor(orgId, PLACE_INDICATE);
  if (!holders.some(c => c.credentialId === id && c.provider === `${driver}.indicate` && c.shared)) throw new LightSetupError("Share this light connection with this workspace before mapping it to a place.");
}

export async function saveGridLights(orgId: string, parent: string, raw: unknown, userId: string | null = null): Promise<number> {
  const config = LightGrid.parse(raw);
  await requireLightConnection(orgId, config.connection_id, config.driver);
  const db = await dbFor(orgId);
  const children = await db.selectFrom("core_locations_locations").select(["id", "metadata"]).where("parent_id", "=", parent).execute();
  let mapped;
  try { mapped = mapLightGrid(children, config); }
  catch (e) { throw new LightSetupError(e instanceof Error ? e.message : "These bins could not be mapped."); }
  await db.transaction().execute(async trx => {
    for (const [id, light] of mapped) await trx.updateTable("core_locations_locations").set({ metadata: platform().db.mergeJsonb("metadata", { light }) as never, updated_at: new Date() }).where("id", "=", id).execute();
  });
  await platform().activity.log({ orgId, userId, action: "location_grid_lights_updated", ref: { module: "core-locations", entityType: "location", entityId: parent }, diff: { grid: config, bins: [...mapped.keys()] }, before: { lights: children.map(c => ({ id: c.id, light: c.metadata.light ?? null })) } });
  for (const id of mapped.keys()) await platform().events.emit("core-locations.location.updated", { orgId, locationId: id });
  return mapped.size;
}

const requests = new Map<string, { indicated?: boolean; error?: string }>();
export async function requestLight(orgId: string, ref: { kind: string; id: string }, reason: typeof LIGHT_EVENTS[number] = LIGHT_EVENTS[1]) {
  const path = (await platform().placement.pathsOf({ orgId, containees: [ref] })).get(`${ref.kind}:${ref.id}`) ?? [];
  const found = await lightSignals.find(orgId, ref);
  if (!found) return { requested: false, place: null, path, note: path.length ? `It is in ${path.map(p => p.name).join(", in ")}. There is no mapped light here yet.` : "There is no mapped light for this place yet." };
  const requestId = randomUUID();
  const result: { indicated?: boolean; error?: string } = {};
  requests.set(`${orgId}:${requestId}`, result);
  try {
    await platform().events.emit(reason, { orgId, locationId: found.place.id, requestId });
    return { requested: result.indicated === true, place: found.place.id, path, note: result.error ?? (result.indicated ? `Lit ${found.place.name ?? "this place"}.` : "This light's wire is off. Enable it on Wires to use it.") };
  } finally { requests.delete(`${orgId}:${requestId}`); }
}

let registered = false;
export function registerLights(): void {
  if (registered) return;
  registered = true;
  for (const adapter of LIGHT_ADAPTERS) platform().services.registerBuiltIn(adapter);
  platform().actions.registerHandler("core-locations.show-me", async ctx => {
    const entity = requireActionEntity(ctx);
    return { ok: true, result: await requestLight(ctx.orgId, entity, entity.kind === "core-locations:location" ? LIGHT_EVENTS[0] : LIGHT_EVENTS[1]) };
  });
  platform().actions.registerHandler("core-locations.indicate", async ctx => {
    const entity = requireActionEntity(ctx);
    const found = await lightSignals.find(ctx.orgId, entity);
    if (!found) return { ok: true, result: { indicated: false } };
    const input = IndicateInput.parse({ place: found.place.id, ...(ctx.args ?? {}) });
    const requestId = (ctx.event?.payload as { requestId?: string } | undefined)?.requestId;
    const pending = requestId ? requests.get(`${ctx.orgId}:${requestId}`) : undefined;
    try {
      const job = await platform().services.invoke({ orgId: ctx.orgId, capability: PLACE_INDICATE, input, via: { credentialId: found.mapping.connection_id } });
      const result = await platform().services.job(ctx.orgId, job.id);
      if (result?.status !== "done") throw new Error(result?.error?.message ?? "The light did not answer.");
      if (pending) pending.indicated = true;
      return { ok: true, result: result.output };
    } catch (e) {
      const error = e instanceof Error ? e.message : "The light did not answer.";
      if (pending) pending.error = error;
      return { ok: false, error };
    }
  });
  platform().actions.registerHandler("core-locations.set-light", async ctx => {
    await savePlaceLight(ctx.orgId, requireActionEntity(ctx).id, (ctx.args as { mapping?: unknown })?.mapping ?? null, ctx.userId);
    return { ok: true, result: { saved: true } };
  });
  platform().actions.registerHandler("core-locations.map-light-grid", async ctx => ({ ok: true, result: { mapped: await saveGridLights(ctx.orgId, requireActionEntity(ctx).id, (ctx.args as { grid?: unknown })?.grid, ctx.userId) } }));
  platform().events.on("core-placement.placed", "core-locations", async raw => {
    const p = raw as { orgId: string; containerKind: string; containerId: string };
    if (p.orgId && p.containerKind && p.containerId) await requestLight(p.orgId, { kind: p.containerKind, id: p.containerId }, LIGHT_EVENTS[3]);
  });
  platform().events.on("core-scan.label.scanned", "core-locations", async raw => {
    const p = raw as { orgId: string; entityKind: string; entityId: string };
    if (p.orgId && p.entityKind && p.entityId) await requestLight(p.orgId, { kind: p.entityKind, id: p.entityId }, LIGHT_EVENTS[4]);
  });
  platform().events.on("core-scan.putaway.destination-selected", "core-locations", async raw => {
    const p = raw as { orgId: string; locationId: string };
    if (p.orgId && p.locationId) await requestLight(p.orgId, { kind: "core-locations:location", id: p.locationId }, LIGHT_EVENTS[3]);
  });
}
