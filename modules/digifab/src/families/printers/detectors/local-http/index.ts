// Generic "any HTTP ML on my LAN" frame-scorer. POSTs the JPEG bytes (multipart
// field `file`) to `/detect` and reads a scalar `{ "probability": 0.x }` back.
// The most portable shape: it works with any frame source (LAN camera OR a
// relayed snapshot) because Cobblr sends the bytes rather than a URL.
//
// This is the starting point for wrapping a home-grown model or any service that
// doesn't match a named package — edit the manifest (path / field / probability
// expr / auth) to fit, or copy this folder to a new one.

import type { DetectorPackage } from "../types.js";
import { DetectorManifest } from "../manifest.js";

export const builtin: DetectorPackage = {
  key: "local-http",
  name: "Generic HTTP detector (LAN)",
  summary: "POST a frame to any model server that returns { probability }.",
  external: true,
  manifest: DetectorManifest.parse({
    id: "local-http",
    name: "Generic HTTP detector",
    shape: "frame-scorer",
    // Optional bearer — harmless when the connection stores no token.
    auth: { kind: "header", header: "Authorization", from: "apiKey", prefix: "Bearer " },
    detect: {
      method: "POST",
      path: "/detect",
      frameRef: "body",
      bodyType: "multipart",
      bodyField: "file",
      probability: "$.probability",
    },
  }),
};
