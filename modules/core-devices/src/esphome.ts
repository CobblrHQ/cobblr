import { platform, type DeviceDriver } from "@cobblr/platform-contract";
import { edgeChannelKey } from "@cobblr/platform-contract/edge-channel";
import type { BuiltInServiceDef } from "@cobblr/platform-contract/services";

export async function esphomeDriver(orgId: string, ref: string): Promise<DeviceDriver | null> {
  const internal = await platform().devices.connections().getInternal(orgId, ref);
  if (!internal || internal.type !== "esphome") return null;
  const connection = await platform().devices.connections().get(orgId, internal.id);
  if (!connection?.enabled) return null;
  const credentials = internal.credentials_enc ? await platform().integrations.decryptCredentials(orgId, internal.credentials_enc) : {};
  const request = async (command: string, params: Record<string, unknown>) => {
    try {
      const response = await platform().edge.fetch(edgeChannelKey(orgId, connection.config.bridge), { baseUrl: connection.base_url, path: "/command", method: "POST", headers: { "content-type": "application/json", ...(typeof credentials.apiKey === "string" ? { authorization: `Bearer ${credentials.apiKey}` } : {}) }, body: { command, params: { ...params, host: connection.config.host, connection: connection.id } }, timeoutMs: 10_000 });
      const body = await response.json() as { ok?: boolean; data?: Record<string, unknown> };
      if (!response.ok || body.ok !== true) throw new Error("Device refused");
      return { ok: true, data: body.data };
    } catch { throw new Error("ESPHome did not answer. Check its bridge, entity and native API settings."); }
  };
  return {
    runCommand: request,
    listDevices: async () => (await request("entities", {})).data?.entities as Array<{ id: string; name: string; state?: string; raw?: { type: string; unit?: string } }> ?? [],
    readSensor: async entity => {
      const reading = (await request("reading", { entity })).data?.reading as { value?: number; unit?: string; at?: string } | undefined;
      if (!reading || typeof reading.value !== "number" || !Number.isFinite(reading.value)) throw new Error("ESPHome has no current reading.");
      return { value: reading.value, unit: reading.unit, at: reading.at };
    },
  };
}

export const ESPHOME_COMMAND: BuiltInServiceDef = {
  id: "esphome.command", name: "ESPHome", connection: {
    group: "esphome.indicate", title: "ESPHome", summary: "Use a device from Devices. Native API keys stay on its bridge.",
    config_schema: { type: "object", properties: { device_connection: { type: "string", title: "Device connection id" }, duration: { type: "string", title: "Seconds to stay lit", default: "30" } }, required: ["device_connection"] },
    test: async (config, ctx) => {
      if (!ctx.orgId) return { ok: true, warning: "Share this connection with a workspace to test its device." };
      try {
        const driver = await esphomeDriver(ctx.orgId, config.device_connection ?? "");
        if (!driver?.listDevices) return { ok: false, reason: "unknown", error: "Choose an ESPHome device connection from this workspace." };
        await driver.listDevices();
        return { ok: true, note: "ESPHome answered through the bridge." };
      } catch { return { ok: false, reason: "unreachable", error: "ESPHome did not answer through its bridge." }; }
    },
  },
  capability: {
    id: "device.esphome.command", version: 1, title: "Run an ESPHome action", summary: "Switch a relay, press a button or set a number or option on an ESPHome device.", effect: "physical", mode: "sync",
    input_schema: { type: "object", properties: { command: { type: "string", enum: ["switch", "button", "number", "select"] }, entity: { type: "string", pattern: "^(switch|button|number|select)-[a-z0-9_]+$" }, state: { type: "boolean" }, value: { type: "number" }, option: { type: "string" } }, required: ["command", "entity"], additionalProperties: false },
    output_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  },
  run: async ctx => {
    const driver = await esphomeDriver(ctx.orgId, ctx.config?.device_connection ?? "");
    if (!driver?.runCommand) throw new Error("Choose an ESPHome device connection from this workspace.");
    const { command, ...params } = ctx.input as Record<string, unknown>;
    const result = await driver.runCommand(String(command), params);
    return { output: { ok: result.ok } };
  },
};
