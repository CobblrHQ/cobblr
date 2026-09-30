// The external print-failure detectors (PrintGuard, Obico ML, a LAN model
// box) as `inspect.print` adapters (services.md §12, the #4034 decision).
//
// They are third-party programs with their own APIs, so each is a built-in
// that speaks its program's API (its declarative detector manifest, run by
// ./engine.ts exactly as before), offered on Add a service with an address
// and a key. A person's connection holds those; this module keeps what is per
// printer (which camera inside the detector watches which printer) on the
// digifab_detectors row linked to that connection (service_connection_id).

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { BuiltInServiceDef } from "@cobblr/platform-contract/services";
import type { DigifabDB } from "../db.js";
import { cameraUrlFor, detectorBaseContext } from "../failure-detect.js";
import { BUILTINS } from "./builtins.generated.js";
import { testDetectorManifest } from "./engine.js";
import { runDetector } from "./registry.js";
import { INSPECT_PRINT } from "./services.js";
import type { DetectorPackage } from "./types.js";

/** An external detector package's built-in id. */
export function detectorAdapterId(key: string): string {
  return `digifab.detector-${key}`;
}

export function detectorAdapter(pkg: DetectorPackage): BuiltInServiceDef {
  return {
    id: detectorAdapterId(pkg.key),
    name: pkg.name,
    capability: INSPECT_PRINT,
    connection: {
      title: pkg.name,
      ...(pkg.summary ? { summary: pkg.summary } : {}),
      config_schema: {
        type: "object",
        properties: {
          base_url: { type: "string", title: "Address", format: "uri", description: `Where ${pkg.name} answers, e.g. http://192.168.1.20:8000` },
          api_key: { type: "string", title: "API key", writeOnly: true, description: "Only if the service asks for one." },
        },
        required: ["base_url"],
      },
      async test(config) {
        if (!pkg.manifest) return { ok: false, reason: "unknown", error: `${pkg.name} has no way to be checked in this build` };
        const r = await testDetectorManifest(pkg.manifest, config.base_url ?? "", config.api_key || null);
        if (r.ok) return { ok: true, ...(r.version ? { note: `${pkg.name} ${r.version}` } : {}) };
        return { ok: false, reason: /401|403|unauthor|forbidden/i.test(r.detail ?? "") ? "invalid_key" : "unreachable", ...(r.detail ? { error: r.detail } : {}) };
      },
    },
    async run(ctx) {
      const input = (ctx.input ?? {}) as { connection_id?: unknown; device_id?: unknown };
      const connId = typeof input.connection_id === "string" ? input.connection_id : "";
      const deviceId = typeof input.device_id === "string" ? input.device_id : "";
      if (!connId || !deviceId) throw new Error("Say which printer: its connection and device.");
      const baseUrl = ctx.config?.base_url;
      if (!baseUrl) throw new Error(`This ${pkg.name} connection has no address.`);
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
      const base = await detectorBaseContext(db, ctx.orgId, connId, deviceId);
      base.cameraUrl = await cameraUrlFor(db, connId, deviceId);
      // Which camera inside the detector watches this printer: kept per
      // printer on the row this connection replaced.
      const settings = ctx.connectionId
        ? await db.selectFrom("digifab_detectors").select(["config"]).where("service_connection_id", "=", ctx.connectionId).executeTakeFirst()
        : undefined;
      const map = ((settings?.config as { camera_map?: Record<string, string> } | undefined)?.camera_map) ?? {};
      const r = await runDetector(pkg, {
        ...base,
        connection: { baseUrl, apiKey: ctx.config?.api_key || null },
        cameraId: map[`${connId}:${deviceId}`] ?? null,
      });
      return { output: { probability: r ? r.probability : null, source: "detector" } };
    },
  };
}

let registered = false;
export function registerDetectorAdapters(): void {
  if (registered) return;
  registered = true;
  for (const pkg of BUILTINS) if (pkg.external && pkg.manifest) platform().services.registerBuiltIn(detectorAdapter(pkg));
}
