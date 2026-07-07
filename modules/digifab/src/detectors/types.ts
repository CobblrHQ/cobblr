// Detector PACKAGE contract — the seam that turns "a way to get a failure
// probability" into a self-contained, per-folder package. Mirrors the
// edge-bridge driver refactor (each driver a folder exporting `builtin`,
// wired by codegen). `edge` and `llm` are built-in packages; external services
// (Obico ML API, PrintGuard, a generic LAN box) are declarative-manifest
// packages. The failure watch resolves a package by key and runs it — nothing
// about a specific service is hardcoded in the watch loop.

import type { MachineDriver } from "../drivers/types.js";
import type { DetectorManifest } from "./manifest.js";

/** Everything a detector might need to produce one reading. Fields are lazy /
 *  nullable so a package uses only what its shape requires. */
export interface DetectorContext {
  orgId: string;
  connId: string;
  deviceId: string;
  /** The LAN/edge driver for on-machine ops (edge model + camera frame), or null. */
  driver: MachineDriver | null;
  /** One live JPEG frame (LAN camera via the bridge, else the relayed snapshot). */
  grabFrame: () => Promise<Buffer | null>;
  /** The device's configured camera URL — a URL an external frame-scorer can
   *  fetch itself (Obico `img=`). Null when none is set. */
  cameraUrl: string | null;
  /** The remote camera id this device maps to inside a camera-watcher service. */
  cameraId: string | null;
  /** The external detector connection (base URL + token), for manifest packages. */
  connection: { baseUrl: string; apiKey: string | null } | null;
}

export interface DetectorPackage {
  /** Stable key — a `digifab_failure_config.backend` value (edge/llm) or a
   *  detector connection's `key`. */
  key: string;
  name: string;
  summary?: string;
  /** True for external services the operator points at a base URL (obico-ml,
   *  printguard, local-http); false for the built-in in-process backends. */
  external?: boolean;
  /** Declarative HTTP manifest (external detectors). Run by ./engine.ts when
   *  the package has no `score` of its own. */
  manifest?: DetectorManifest;
  /** Code hook for the in-process backends (edge/llm) or anything a manifest
   *  can't express. Returns a probability in [0,1], or null for no reading. */
  score?: (ctx: DetectorContext) => Promise<{ probability: number } | null>;
}
