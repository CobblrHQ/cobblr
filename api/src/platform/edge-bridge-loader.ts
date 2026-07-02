// The edge-bridge BOOTSTRAP loader, served at GET /orgs/:slug/edge/release/loader.
//
// Closes the "private registry" install gap: the docker command runs a STOCK
// public image (node:22-alpine) that wgets THIS file from the user's own Cobblr
// (authed with the same devices:edge token it tunnels with) and runs it. The
// loader fetches the sha-verified bridge bundle from /release/bundle, runs it
// in-process, and polls for updates — code delivery is 100% from the control
// plane the bridge already trusts. No Docker registry, no PAT, no Watchtower;
// works for any stranger on any network.
//
// Update model: a new bundle version → exit(0); `restart: unless-stopped`
// re-runs the container command, which re-fetches this loader too (with a
// cached-copy fallback so a cloud blip can't brick restarts) and lands on the
// new bundle. The edge-bridge image's own baked loader (edge-bridge repo,
// src/loader.ts) remains for the registry-image path; this one is the
// registry-free twin, owned by core so the install path needs nothing else.
//
// Constraints on the code below: plain .mjs, node builtins only, top-level
// await, and NO backticks/template-dollars (it lives inside a TS string).

export const BRIDGE_LOADER_JS: string = [
  '// cobblr edge-bridge bootstrap loader — served by GET <relay>/release/loader.',
  '// Env: BRIDGE_RELAY_URL, BRIDGE_RELAY_TOKEN (the bridge bundle reads the rest).',
  'import { createHash } from "node:crypto";',
  'import { createRequire } from "node:module";',
  'import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";',
  'import path from "node:path";',
  'import process from "node:process";',
  '',
  'const RELAY = (process.env.BRIDGE_RELAY_URL || "").replace(/\\/+$/, "");',
  'const TOKEN = process.env.BRIDGE_RELAY_TOKEN || "";',
  'const DIR = process.env.BRIDGE_CACHE_DIR || process.cwd();',
  'const BUNDLE = path.join(DIR, "bridge.cjs");',
  'const VERSION = path.join(DIR, "bridge.version");',
  'const CHECK_MS = 30 * 60 * 1000;',
  'if (!RELAY) { console.error("[loader] BRIDGE_RELAY_URL is required"); process.exit(1); }',
  'const auth = TOKEN ? { authorization: "Bearer " + TOKEN } : {};',
  '',
  'async function release() {',
  '  const r = await fetch(RELAY + "/release", { headers: auth });',
  '  if (!r.ok) throw new Error("release " + r.status);',
  '  return await r.json();',
  '}',
  '',
  'async function download(rel) {',
  '  const r = await fetch(RELAY + "/release/bundle", { headers: auth });',
  '  if (!r.ok) throw new Error("bundle " + r.status);',
  '  const js = await r.text();',
  '  const sha = createHash("sha256").update(js).digest("hex");',
  '  if (sha !== rel.sha256) throw new Error("bundle sha mismatch");',
  '  mkdirSync(DIR, { recursive: true });',
  '  writeFileSync(BUNDLE + ".tmp", js);',
  '  renameSync(BUNDLE + ".tmp", BUNDLE);',
  '  writeFileSync(VERSION, rel.version);',
  '}',
  '',
  'const current = () => (existsSync(VERSION) ? readFileSync(VERSION, "utf8").trim() : "");',
  '',
  '// First boot fetches the bundle; retry while the cloud is unreachable — the',
  '// container has nothing better to do than keep trying.',
  'for (;;) {',
  '  try {',
  '    if (!existsSync(BUNDLE)) { await download(await release()); }',
  '    break;',
  '  } catch (e) {',
  '    console.error("[loader] bootstrap: " + e.message + " — retrying in 15s");',
  '    await new Promise((r) => setTimeout(r, 15000));',
  '  }',
  '}',
  '',
  '// Poll for updates: new version → sha-verified download → exit(0); docker',
  '// restarts the command, which re-fetches this loader and runs the new bundle.',
  'setInterval(async () => {',
  '  try {',
  '    const rel = await release();',
  '    if (rel.version && rel.version !== current()) {',
  '      await download(rel);',
  '      console.error("[loader] updated to " + rel.version.slice(0, 12) + " — restarting to apply");',
  '      process.exit(0);',
  '    }',
  '  } catch { /* transient — next tick */ }',
  '}, CHECK_MS);',
  '',
  'console.error("[loader] running bridge " + (current().slice(0, 12) || "unknown"));',
  'createRequire(import.meta.url)(BUNDLE);',
  '',
].join("\n");
