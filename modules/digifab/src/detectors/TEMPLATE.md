# Authoring a detector — the manifest template

A **detector** is an external print-failure service Cobblr can talk to (PrintGuard,
Obico ML API, any HTTP model). Adding one is **data, not code**: drop a folder here
with an `index.ts` that exports a `builtin`, and the codegen (`scripts/gen-detectors.mjs`)
wires it into the registry automatically. Delete the folder to hold it back — no build
break. Nothing about a specific service is hardcoded anywhere else.

This file is the copy-paste reference for the whole manifest. Grab the shape you need
(frame-scorer or camera-watcher), then add only the optional blocks you want — every
block below is optional unless marked required.

## 1. The package (`modules/digifab/src/detectors/<your-service>/index.ts`)

```ts
import type { DetectorPackage } from "../types.js";
import { DetectorManifest } from "../manifest.js";

export const builtin: DetectorPackage = {
  key: "my-service",            // stable id; a detector connection's `type` references it
  name: "My Service",           // shown in the "add a detector" picker
  summary: "One line for the picker.",
  external: true,               // true = operator points it at a base URL (in the catalog)
  manifest: DetectorManifest.parse({
    /* … one of the shapes below … */
  }),
};
```

(The built-in `edge` / `llm` packages instead provide a `score(ctx)` function and no
manifest — that's for in-process backends, not external services. You want a manifest.)

## 2. Required fields + auth

```ts
{
  id: "my-service",             // required, [a-z0-9_-]
  name: "My Service",           // required
  shape: "frame-scorer",        // required: "frame-scorer" | "camera-watcher" (see §3)
  // Optional header auth — sent as `<header>: <prefix?><apiKey>`:
  auth: { kind: "header", header: "Authorization", from: "apiKey", prefix: "Bearer " },
}
```

## 3. How a probability comes out — pick your shape

Cobblr folds each reading into its own rolling score (EWM) and trips at your threshold,
so a manifest only has to turn one sample into a number in `[0,1]` (or null = no reading).

**A. `frame-scorer`** — Cobblr hands the service a frame and reads a verdict back. Use
`frameRef: "url"` (the service fetches a snapshot URL you pass) or `"body"` (Cobblr POSTs
the JPEG bytes — works even for a relayed snapshot the service can't reach itself).

```ts
detect: {
  method: "POST",
  path: "/classify",
  frameRef: "body",                 // "url" → path may use {frameUrl}; "body" → POST bytes
  bodyType: "raw",                  // body only: "raw" (bytes) | "multipart" (default)
  bodyField: "file",                // multipart only: the form field name
  contentType: "image/jpeg",        // raw only
  // …plus ONE read (numeric or categorical), see below…
}
```

**B. `camera-watcher`** — the service pulls its own camera; Cobblr reads its verdict for a
mapped camera. `path` may use `{deviceCam}` (the mapped camera id).

```ts
status: {
  method: "GET",
  path: "/api/v1/cameras/{deviceCam}",
  // …plus ONE read (numeric or categorical), see below…
}
```

**The read** (goes inside `detect` or `status`) is either **numeric** or **categorical**:

```ts
// numeric — an extract expr → a 0..1 number:
probability: "$.risk",        // the value
reduce: "max",                // "max" (array of detections; empty ⇒ 0) | "first" | omit (scalar)
divisor: 100,                 // optional: normalise 0..100 → 0..1

// OR categorical — a class string mapped to 1.0 / 0.0:
label: "$.prediction",        // string field
failureValues: ["failure"],   // → 1.0
successValues: ["success"],   // → 0.0 ; anything else (e.g. "unknown") ⇒ no reading
```

### Extract-expr DSL (used by every `map` / `probability` / `label` / `extract`)
`$` root · `.key` · `[n]` index · `[*]` spread over an array · `='literal'` · `={templateVar}`.
Examples: `$.risk` · `$[*][1]` (2nd element of each item) · `$.detections[*].confidence`.

## 4. Optional: version gate

Enforce a minimum service version — e.g. a capability that only exists from some release.
Cobblr's **Test** button reads the version, semver-compares, and reports it clearly
("needs My Service ≥ 2.3.0, found 2.2.2"); a too-old box comes back not-ok.

```ts
serviceVersion: { method: "GET", path: "/api/v1/state", extract: "$.version" },
minServiceVersion: "2.3.0",   // omit if any version works
```

## 5. Optional: health probe

```ts
health: { method: "GET", path: "/hc/" },   // Test hits this; else a bare GET of the base URL
```

## 6. Optional: full-mode management (camera-watcher services that own printers)

Only for services like PrintGuard that manage their own cameras/printers/monitors. Lets
Cobblr import + link cameras, register printers, and read print state. Skip all of this for
a plain scorer.

```ts
// Import the service's cameras (Cobblr shows a picker to link them to machines):
listCameras: {
  method: "GET", path: "/api/v1/cameras", arrayPath: "$",   // arrayPath: $ if body IS the array
  map: { id: "$.id", name: "$.name", online: "$.online", printerId: "$.printer_id" },
},
// Register a printer + bind a monitor so the service watches:
listProviders: { method: "GET", path: "/api/v1/state", arrayPath: "$.integrations",
                 map: { id: "$.id", label: "$.label", schema: "$.schema" } },
createPrinter: { method: "POST", path: "/api/v1/printers" },
createMonitor: { method: "POST", path: "/api/v1/monitors" },
// Read the service's printers' live state (for Cobblr to consume when it owns them):
listPrinters: { method: "GET", path: "/api/v1/printers",
                map: { id: "$.id", name: "$.name", status: "$.device_state.status", progress: "$.device_state.progress" } },
```

### Generic mirror (`connectionMappings`) — "add THIS Cobblr machine to the service"
Map a Cobblr digifab connection type → one of the service's providers, as data. `config`
fills each provider field from an extract-expr over the connection context
`{ base_url, apiKey, username, password, device? }`. `perDevice` = per-printer (needs a
device id/serial; Cobblr supplies its stored per-device creds as `device`).

```ts
connectionMappings: [
  { from: "octoprint", provider: "octoprint", config: { base_url: "$.base_url", api_key: "$.apiKey" } },
  { from: "bambu", provider: "bambu", perDevice: true,
    config: { host: "$.device.host", serial: "$.device.serial", access_code: "$.device.access_code" } },
],
```

## 7. Two complete minimal examples

**Frame-scorer** (Cobblr posts a frame, reads a categorical verdict):
```ts
DetectorManifest.parse({
  id: "my-scorer", name: "My Scorer", shape: "frame-scorer",
  auth: { kind: "header", header: "Authorization", from: "apiKey", prefix: "Bearer " },
  detect: { method: "POST", path: "/classify", frameRef: "body", bodyType: "raw",
            contentType: "image/jpeg", label: "$.prediction",
            failureValues: ["failure"], successValues: ["success"] },
})
```

**Camera-watcher** (service owns the camera; Cobblr reads a 0..1 risk):
```ts
DetectorManifest.parse({
  id: "my-watcher", name: "My Watcher", shape: "camera-watcher",
  auth: { kind: "header", header: "Authorization", from: "apiKey", prefix: "Bearer " },
  status: { method: "GET", path: "/cameras/{deviceCam}", probability: "$.risk" },
  listCameras: { method: "GET", path: "/cameras", map: { id: "$.id", name: "$.name" } },
})
```

See `obico-ml/`, `local-http/`, `printguard/`, and `printguard-frame/` for real, shipped
examples of each combination.
