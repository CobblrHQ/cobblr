#!/usr/bin/env node
// Marketplace v0.2 image-build pipeline.
//
// Called from docker/api.Dockerfile during build. Reads
// cobblr-modules.json, for each entry either:
//
//   source: "vendored" — assumes modules/<name>/ is already present
//                        in the build context (the COPY step put it
//                        there). Records the manifest. No fetch.
//
//   source: "registry" — fetches the registry, looks up name +
//                        version, downloads the tarball, verifies
//                        sha256 + ed25519 signature against the
//                        registry's public key, extracts to
//                        modules/<name>/.
//
// Output: writes /app/installed-modules.manifest.json (consumed at
// api boot to populate the installed_modules table) and ensures
// every module is present + buildable.
//
// Run from repo root: node scripts/install-registry-modules.mjs

import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function log(msg) {
  console.log(`[install-registry-modules] ${msg}`);
}

function fail(msg) {
  console.error(`[install-registry-modules] FAIL: ${msg}`);
  process.exit(1);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function authHeaders(url) {
  // NOTE: this mirrors api/src/lib/github-registry.ts — that's the canonical
  // version. This script runs standalone at image-build time (plain node,
  // no compiled api), so it can't import it. `lint:registry-headers-sync`
  // compares the two BEHAVIORALLY in CI, so drift fails the build instead of
  // waiting to be noticed.
  //
  // GITHUB_TOKEN env (or COBBLR_REGISTRY_TOKEN as an alias) lets us
  // fetch from private cobblrhq/* repos + releases. We only attach it to
  // github.com / api.github.com / raw.githubusercontent.com URLs —
  // never to S3 redirect targets (undici strips Authorization on
  // cross-origin redirects in Node 22+, but we belt-and-suspenders
  // by scoping the header to GH origins to begin with).
  //
  // Contents API returns the raw file body with this Accept AND authenticates
  // PRIVATE repos via Bearer — raw.githubusercontent does NOT accept a Bearer
  // for private repos (it just 404s). The Accept applies even with NO token
  // (a public repo fetched via api.github.com still needs it to get the raw
  // body, not base64 metadata — the no-token divergence the sync lint caught).
  // fetchBuffer overrides Accept to octet-stream for binary downloads.
  const token = process.env.COBBLR_REGISTRY_TOKEN || process.env.GITHUB_TOKEN;
  const h = {};
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    h.Accept = "application/vnd.github.raw+json";
    if (token) h.Authorization = `Bearer ${token}`;
  } else if (/^https:\/\/([^/]*\.)?githubusercontent\.com\b/.test(url) && token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

async function fetchBuffer(url) {
  // file:// is allowed for local fixtures + air-gapped builds.
  if (url.startsWith("file://")) {
    return readFileSync(fileURLToPath(url));
  }
  // GH release assets respond to api.github.com with the asset bytes
  // when Accept is octet-stream — keeps Authorization safe through
  // the redirect chain. Browser-facing release URLs (releases/download/…)
  // also work; undici strips Authorization on cross-origin redirect.
  const res = await fetch(url, { headers: { ...authHeaders(url), Accept: "application/octet-stream" } });
  if (!res.ok) fail(`fetch ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchJson(url) {
  if (url.startsWith("file://")) {
    return JSON.parse(readFileSync(fileURLToPath(url), "utf-8"));
  }
  const res = await fetch(url, { headers: authHeaders(url) });
  if (!res.ok) fail(`fetch ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

function verifyEd25519(publicKeyB64, tarball, signatureB64) {
  // public key is a base64-encoded DER SubjectPublicKeyInfo (the
  // shape `openssl pkey -outform DER -pubout` and Node's
  // KeyObject.export({format:"der",type:"spki"}) produce).
  const keyDer = Buffer.from(publicKeyB64, "base64");
  const pubKey = createPublicKey({ key: keyDer, format: "der", type: "spki" });
  const sig = Buffer.from(signatureB64, "base64");
  return cryptoVerify(null, tarball, pubKey, sig);
}

function extractTarball(tarballBuf, destDir) {
  // We don't have a pure-JS tar that handles gzip well at this size,
  // and the build image has bsdtar/gnu tar available. Pipe via stdin.
  mkdirSync(destDir, { recursive: true });
  const tmpPath = `/tmp/registry-module-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`;
  writeFileSync(tmpPath, tarballBuf);
  // Tarballs from scripts/package.mjs are flat (package.json + dist/
  // + src/ at the root) — no containing dir, no --strip-components.
  // If a future module author packs with a containing dir, the install
  // will still work as long as the manifest at the top level is
  // findable; we don't strip.
  const r = spawnSync("tar", ["-xzf", tmpPath, "-C", destDir], { stdio: "inherit" });
  if (r.status !== 0) fail(`tar extract failed (status ${r.status})`);
}

function readManifestFromExtractedDir(moduleDir) {
  // The module's package.json + manifest live at the root of the
  // extracted tarball. We surface the package.json contents +
  // (if present) the manifest.json a future module-author might
  // include. Loader will still call defineModule() at runtime.
  const pkgPath = resolve(moduleDir, "package.json");
  if (!existsSync(pkgPath)) fail(`${moduleDir} missing package.json after extract`);
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

async function main() {
  // COBBLR_MODULES_JSON override exists for tests / fixtures; the
  // image-build path reads the committed cobblr-modules.json.
  const manifestPath = process.env.COBBLR_MODULES_JSON
    ? resolve(process.env.COBBLR_MODULES_JSON)
    : resolve(REPO_ROOT, "cobblr-modules.json");
  if (!existsSync(manifestPath)) {
    log("no cobblr-modules.json — nothing to install.");
    writeFileSync(resolve(REPO_ROOT, "installed-modules.manifest.json"), JSON.stringify({ modules: [] }, null, 2));
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const registryUrl = manifest.registry_url;
  const wanted = manifest.modules || [];
  log(`reading ${wanted.length} module entr${wanted.length === 1 ? "y" : "ies"}`);

  // Lazy-fetch the registry only when at least one module needs it.
  let registry = null;
  async function getRegistry() {
    if (registry) return registry;
    if (!registryUrl) fail("modules use source: \"registry\" but cobblr-modules.json has no registry_url");
    log(`fetching registry ${registryUrl}`);
    registry = await fetchJson(registryUrl);
    return registry;
  }

  const installed = [];

  for (const entry of wanted) {
    const { name, version, source } = entry;
    if (!name || !version || !source) fail(`malformed entry: ${JSON.stringify(entry)}`);
    // kind: "module" (the in-process default) or "sandboxed" (wasm,
    // marketplace v0.3). Installed under different repo dirs but
    // the fetch / verify / extract path is identical.
    const kind = entry.kind === "sandboxed" ? "sandboxed" : "module";
    const targetDir =
      kind === "sandboxed"
        ? resolve(REPO_ROOT, "sandboxed-modules", name)
        : resolve(REPO_ROOT, "modules", name);

    if (source === "vendored") {
      if (!existsSync(targetDir)) fail(`${name}@${version} is vendored but ${targetDir} is missing in the build context`);
      let resolvedVersion = version;
      const pkgPath = resolve(targetDir, "package.json");
      const manifestPath = resolve(targetDir, "manifest.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.version && pkg.version !== version) {
          log(`WARN: cobblr-modules.json pins ${name}@${version} but vendored package.json says ${pkg.version}. Using vendored.`);
        }
        resolvedVersion = pkg.version ?? version;
      } else if (existsSync(manifestPath)) {
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (m.version && m.version !== version) {
          log(`WARN: cobblr-modules.json pins ${name}@${version} but vendored manifest.json says ${m.version}. Using vendored.`);
        }
        resolvedVersion = m.version ?? version;
      }
      log(`${name}@${resolvedVersion}: vendored (${kind}) (${targetDir})`);
      installed.push({
        name,
        version: resolvedVersion,
        band: "marketplace",
        kind,
        source: "vendored",
        source_url: null,
        source_sha256: null,
        signed_by: null,
      });
      continue;
    }

    if (source === "registry") {
      const reg = await getRegistry();
      const modSpec = reg.modules?.find((m) => m.name === name);
      if (!modSpec) fail(`${name} not in registry ${registryUrl}`);
      const versionSpec = modSpec.versions?.find((v) => v.version === version);
      if (!versionSpec) fail(`${name}@${version} not in registry`);
      if (!versionSpec.sha256) fail(`${name}@${version} registry entry has no sha256 — refusing to install`);
      if (!modSpec.public_key_ed25519 || !versionSpec.signature) {
        fail(`${name}@${version} missing public key or signature — refusing to install`);
      }
      log(`${name}@${version}: fetching ${versionSpec.source_url}`);
      const tarball = await fetchBuffer(versionSpec.source_url);
      const gotSha = sha256(tarball);
      if (gotSha !== versionSpec.sha256) {
        fail(`${name}@${version} sha256 mismatch: registry=${versionSpec.sha256} got=${gotSha}`);
      }
      const sig = versionSpec.signature.startsWith("ed25519:")
        ? versionSpec.signature.slice("ed25519:".length)
        : versionSpec.signature;
      if (!verifyEd25519(modSpec.public_key_ed25519, tarball, sig)) {
        fail(`${name}@${version} ed25519 signature did NOT verify against public key in registry`);
      }
      log(`${name}@${version}: sha256 + signature ok, extracting to ${kind}`);
      extractTarball(tarball, targetDir);
      let resolvedVersion = version;
      const pkgPath = resolve(targetDir, "package.json");
      const manifestPath = resolve(targetDir, "manifest.json");
      if (existsSync(pkgPath)) {
        resolvedVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? version;
      } else if (existsSync(manifestPath)) {
        resolvedVersion = JSON.parse(readFileSync(manifestPath, "utf-8")).version ?? version;
      } else if (kind === "module") {
        fail(`${targetDir} missing package.json after extract`);
      }
      installed.push({
        name,
        version: resolvedVersion,
        band: "marketplace",
        kind,
        source: "registry",
        source_url: versionSpec.source_url,
        source_sha256: versionSpec.sha256,
        signed_by: modSpec.public_key_ed25519,
      });
      continue;
    }

    fail(`unknown source "${source}" for ${name}@${version}`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    modules: installed,
  };
  writeFileSync(resolve(REPO_ROOT, "installed-modules.manifest.json"), JSON.stringify(out, null, 2));
  log(`wrote installed-modules.manifest.json (${installed.length} module${installed.length === 1 ? "" : "s"})`);
}

// Run main only when executed directly — `lint:registry-headers-sync` imports
// this module for `authHeaders`, and an import must not run the installer.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
