// `inspect.print`: is this print failing? The in-process detectors as built-in
// services (services.md §12, amended on #4034).
//
// The failure watch reads a probability from a detector every few seconds.
// The detectors were a registry of their own (edge ONNX on the bridge, the
// workspace's AI, and external services a person points at a URL), a service
// in everything but name: a frame in, a probability out. As a capability
// they are listed and ordered like any other, and a connected inspection
// service can stand beside them.
//
// These two wrap the existing packages unchanged, with the same context the
// watch builds (detectorBaseContext), so a reading through the service is the
// reading the watch takes. The watch loop, its smoothing, the threshold and
// auto-pause stay in digifab.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { BuiltInServiceDef, ServiceCapabilityDecl } from "@cobblr/platform-contract/services";
import type { DigifabDB } from "../db.js";
import { detectorBaseContext } from "../failure-detect.js";
import { resolveDetector, runDetector } from "./registry.js";
import type { DetectorContext, DetectorPackage } from "./types.js";

export const INSPECT_PRINT: Omit<ServiceCapabilityDecl, "options_endpoint"> = {
  id: "inspect.print",
  version: 1,
  title: "Check a print for failure",
  summary:
    "Looks at a printer's camera and says how likely the print on it is failing (spaghetti, detached, blobbed), from 0 to 1. No reading when there is nothing to see.",
  effect: "none",
  mode: "sync",
  input_schema: {
    type: "object",
    properties: {
      connection_id: { type: "string", title: "The machine connection the printer is on" },
      device_id: { type: "string", title: "The printer" },
    },
    required: ["connection_id", "device_id"],
    additionalProperties: false,
  },
  output_schema: {
    type: "object",
    properties: {
      probability: { type: ["number", "null"], minimum: 0, maximum: 1 },
      source: { type: "string" },
    },
    required: ["probability", "source"],
  },
};

export interface DetectorServiceDeps {
  getDb(orgId: string): Promise<Kysely<DigifabDB>>;
  context(db: Kysely<DigifabDB>, orgId: string, connId: string, deviceId: string): Promise<Omit<DetectorContext, "connection" | "cameraId">>;
  resolve(key: string): DetectorPackage | null;
  run: typeof runDetector;
}
const REAL: DetectorServiceDeps = {
  getDb: async (orgId) => (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>,
  context: detectorBaseContext,
  resolve: resolveDetector,
  run: runDetector,
};

/** One in-process detector package as an `inspect.print` built-in. */
export function detectorBuiltIn(key: "edge" | "llm", name: string, deps: DetectorServiceDeps = REAL): BuiltInServiceDef {
  return {
    id: `digifab.inspect-${key === "llm" ? "ai" : key}`,
    name,
    capability: INSPECT_PRINT,
    async run(ctx) {
      const input = (ctx.input ?? {}) as { connection_id?: unknown; device_id?: unknown };
      const connId = typeof input.connection_id === "string" ? input.connection_id : "";
      const deviceId = typeof input.device_id === "string" ? input.device_id : "";
      if (!connId || !deviceId) throw new Error("Say which printer: its connection and device.");
      const pkg = deps.resolve(key);
      if (!pkg) throw new Error(`The ${name} detector is not part of this build.`);
      const db = await deps.getDb(ctx.orgId);
      const base = await deps.context(db, ctx.orgId, connId, deviceId);
      // No reading is an answer (nothing on the bed, no model on the bridge),
      // not a failure: the watch reads a null the same way today.
      const r = await deps.run(pkg, { ...base, connection: null, cameraId: null });
      return { output: { probability: r ? r.probability : null, source: key } };
    },
  };
}

let registered = false;
export function registerDetectorServices(): void {
  if (registered) return;
  registered = true;
  platform().services.registerBuiltIn(detectorBuiltIn("edge", "Print check on the bridge"));
  platform().services.registerBuiltIn(detectorBuiltIn("llm", "Print check by the workspace's AI"));
}
