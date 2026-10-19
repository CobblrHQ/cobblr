// PrintGuard in FRAME-SCORER mode — the "Cobblr owns the printer, relays frames"
// path (Mode A / direction 1). Cobblr grabs a frame and POSTs it to PrintGuard's
// classify endpoint; PrintGuard scores it and returns a verdict. Use this when
// PrintGuard CAN'T reach the camera but Cobblr can (cloud Cobblr + LAN camera via
// the bridge), where the camera-watcher `printguard` package doesn't fit.
//
// TARGETS PrintGuard >= 2.3.0. The maintainer accepted #79 into v2.3.0 shaped as
// Platform.decode_jpeg + Engine.classify() behind a thin `POST /api/v1/classify`
// route (+ a classify_frame MCP tool), returning
//   { prediction: "success"|"failure"|"unknown", distances, margin, defect_score }
// This reads the guaranteed CATEGORICAL `prediction` (failure→1 / success→0 /
// unknown→no reading) and lets Cobblr's EWM smooth it — same treatment as the
// camera-watcher package. `defect_score` (0..1) is a smoother alternative once the
// 2.3.0 REST shape is confirmed (swap `label` for `probability: "$.defect_score"`).
//
// VERIFY BEFORE MERGING: this is held on a branch until 2.3.0 ships — confirm the
// live endpoint's request encoding (raw JPEG body vs multipart vs base64 JSON) and
// response fields against a real 2.3.0 instance, then adjust `bodyType`/`path`/read.

import type { DetectorPackage } from "../types.js";
import { DetectorManifest } from "../manifest.js";

export const builtin: DetectorPackage = {
  key: "printguard-frame",
  name: "PrintGuard (send frames)",
  summary: "Cobblr posts a frame to PrintGuard's /classify. For when PrintGuard can't reach the camera. Needs PrintGuard ≥ 2.3.0.",
  external: true,
  manifest: DetectorManifest.parse({
    id: "printguard-frame",
    name: "PrintGuard (frame scorer)",
    shape: "frame-scorer",
    auth: { kind: "header", header: "Authorization", from: "apiKey", prefix: "Bearer " },
    // /classify lands in 2.3.0 — Cobblr's Test gates on this so an older instance
    // reports incompatible instead of silently returning "no reading".
    serviceVersion: { method: "GET", path: "/api/v1/state", extract: "$.version" },
    minServiceVersion: "2.3.0",
    detect: {
      method: "POST",
      path: "/api/v1/classify",
      frameRef: "body",
      bodyType: "raw",
      contentType: "image/jpeg",
      label: "$.prediction",
      failureValues: ["failure"],
      successValues: ["success"],
    },
  }),
};
