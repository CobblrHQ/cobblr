// PrintGuard (github.com/oliverbravery/PrintGuard) — a camera-watcher. It pulls
// its own camera and keeps a rolling risk score; Cobblr reads that score for the
// mapped camera. Bearer token (read scope is enough). GPL-2.0 — omit this folder
// to hold it out of a distributed build.
//
// VERIFIED against a live PrintGuard 2.2.2 (source read on the running container).
// A camera at GET /api/v1/cameras/{id} serialises `Camera.public()`:
//   { id, name, source, printer_id, max_fps, target_fps, achieved_fps,
//     inferring, in_use, online, last_result, brightness, contrast, … }
// The failure signal is CATEGORICAL: `last_result` is the raw classifier output
//   { prediction: "failure" | "success" | "unknown", distances, margin }
// — there is NO ready 0–1 field on the camera. (The smoothed 0–1 "defect score"
// is computed PER-MONITOR via defect_score(sensitivity) and only surfaced as a
// number over MQTT, ×100.) So we read the per-frame prediction and let Cobblr's
// own EWM smooth it: failure → 1.0, success → 0.0, unknown/absent → no reading
// (the watch idles, e.g. when PrintGuard isn't actively inferring this camera).
//
// NOTE: a camera only infers while PrintGuard has a MONITOR bound to it (its own
// camera+printer+monitor setup) — a camera-watcher owns its pipeline. Auth is
// `Authorization: Bearer pg_…`; camera ids come from GET /api/v1/cameras.

import type { DetectorPackage } from "../types.js";
import { DetectorManifest } from "../manifest.js";

export const builtin: DetectorPackage = {
  key: "printguard",
  name: "PrintGuard",
  summary: "Reads PrintGuard's per-camera prediction (failure/success). Camera-watcher, bearer auth.",
  external: true,
  manifest: DetectorManifest.parse({
    id: "printguard",
    name: "PrintGuard",
    shape: "camera-watcher",
    auth: { kind: "header", header: "Authorization", from: "apiKey", prefix: "Bearer " },
    // The running version (for min-version gating): GET /api/v1/state → version.
    serviceVersion: { method: "GET", path: "/api/v1/state", extract: "$.version" },
    status: {
      method: "GET",
      path: "/api/v1/cameras/{deviceCam}",
      label: "$.last_result.prediction",
      failureValues: ["failure"],
      successValues: ["success"],
    },
    // Import list: GET /api/v1/cameras returns the camera objects; Cobblr shows
    // them in a picker so you link a machine → a camera without typing the id.
    // printer_id lets us auto-bind a monitor to a printer's own camera.
    listCameras: {
      method: "GET",
      path: "/api/v1/cameras",
      map: { id: "$.id", name: "$.name", online: "$.online", printerId: "$.printer_id" },
    },
    // Full-mode management (needs a `manage` token). Register a printer in
    // PrintGuard (which auto-registers its webcam as a camera), bind a monitor so
    // it watches, and read the printers' live state back.
    listProviders: {
      method: "GET",
      path: "/api/v1/state",
      arrayPath: "$.integrations",
      map: { id: "$.id", label: "$.label", schema: "$.schema" },
    },
    createPrinter: { method: "POST", path: "/api/v1/printers" },
    createMonitor: { method: "POST", path: "/api/v1/monitors" },
    listPrinters: {
      method: "GET",
      path: "/api/v1/printers",
      map: { id: "$.id", name: "$.name", status: "$.device_state.status", progress: "$.device_state.progress" },
    },
    // Mirror an existing Cobblr connection into PrintGuard — DATA, so any digifab
    // type is supported by adding a row. PrintGuard's OctoPrint/Moonraker want
    // { base_url, api_key }; Bambu wants { host, serial, access_code } per printer
    // (verified from /api/v1/state.integrations). Cobblr fills `$.device.*` from
    // the connection's per-printer creds (Bambu's serial→{host,access_code} map).
    connectionMappings: [
      { from: "octoprint", provider: "octoprint", config: { base_url: "$.base_url", api_key: "$.apiKey" } },
      { from: "klipper-moonraker", provider: "moonraker", config: { base_url: "$.base_url", api_key: "$.apiKey" } },
      { from: "bambu", provider: "bambu", perDevice: true, config: { host: "$.device.host", serial: "$.device.serial", access_code: "$.device.access_code" } },
    ],
  }),
};
