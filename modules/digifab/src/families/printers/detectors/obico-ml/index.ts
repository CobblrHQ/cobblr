// Obico ML API (The Spaghetti Detective's `ml_api`, self-hosted standalone).
// A stateless frame-scorer: GET /p/?img=<url> and it fetches + scores the frame,
// returning [["failure", <conf>, [box]], …]. Probability = the max confidence
// over the array (empty ⇒ 0.0, a clean frame). AGPL-3.0 — omit this folder to
// hold it out of a distributed build.
//
// The `img` URL must be reachable BY the Obico container, so this uses url mode:
// the device's configured camera URL is handed to Obico. (For a snapshot the box
// can't reach, use the generic `local-http` body-POST detector instead.)

import type { DetectorPackage } from "../types.js";
import { DetectorManifest } from "../manifest.js";

export const builtin: DetectorPackage = {
  key: "obico-ml",
  name: "Obico ML API (self-hosted)",
  summary: "The Spaghetti Detective's ml_api, run standalone. Frame-scorer, no auth.",
  external: true,
  manifest: DetectorManifest.parse({
    id: "obico-ml",
    name: "Obico ML API",
    shape: "frame-scorer",
    health: { method: "GET", path: "/hc/" },
    detect: {
      method: "GET",
      path: "/p/?img={frameUrl}",
      frameRef: "url",
      probability: "$[*][1]",
      reduce: "max",
    },
  }),
};
