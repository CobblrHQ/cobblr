// Runtime install endpoint for sandboxed marketplace modules.
//
// POST /api/v1/sandbox/install — super-admin only. Body:
//   { name: string, version: string, registry_url?: string }
//
// Fetches the registry, validates the entry's sha256 + ed25519
// signature, extracts to RUNTIME_INSTALL_DIR, then registers + mounts
// the module so it's immediately available. The install is logged
// in installed_modules with source="runtime".
//
// The actual fetch/verify/extract logic lives in
// scripts/install-registry-modules.mjs at image-build time; we
// re-implement the same flow here for the runtime path. Keeping
// them aligned is mandatory — drift would create install asymmetry
// (some modules verifiable at build but not runtime, or vice versa).

import { Router } from "express";
import { z } from "zod";
import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { spawnSync } from "node:child_process";
import { sql } from "kysely";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware.js";
import { meta } from "../db/meta.js";
import { RUNTIME_INSTALL_DIR, loadOneSandboxedModule, uninstallSandboxedModule } from "../sandbox/loader.js";
import { mountNewlyRegistered } from "../modules/mount.js";
import { fetchGithubJson, fetchGithubBuffer } from "../lib/github-registry.js";
export const sandboxInstallRouter = Router();
sandboxInstallRouter.use(requireAuth, requirePlatformAdmin);

const InstallBody = z.object({
  name: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  version: z.string().min(1).max(64),
  /** Override the registry URL. Defaults to the operator-curated
   *  cobblrhq/registry. Useful for testing against a local fixture. */
  registry_url: z.string().url().optional(),
  /** TOFU override: a module's signing key is pinned on first install;
   *  an update signed by a DIFFERENT key is rejected unless this is set
   *  (the operator re-consents to the key change). */
  allow_key_change: z.boolean().optional(),
});

const DEFAULT_REGISTRY =
  // `||` not `??` — compose passes an EMPTY string when unset. The repo is
  // PRIVATE, so this is the GitHub contents-API URL (Bearer-authed, returns
  // raw JSON); see api/src/lib/github-registry.ts for why a raw.github URL
  // can't auth private repos. When the repo goes public a raw URL works too.
  process.env.COBBLR_REGISTRY_URL ||
  "https://api.github.com/repos/CobblrHQ/registry/contents/modules.json";

function verifyEd25519(publicKeyB64: string, tarball: Buffer, signatureB64: string): boolean {
  const keyDer = Buffer.from(publicKeyB64, "base64");
  const pubKey = createPublicKey({ key: keyDer, format: "der", type: "spki" });
  const sig = Buffer.from(signatureB64, "base64");
  return cryptoVerify(null, tarball, pubKey, sig);
}

/** Audit a tarball's members BEFORE extraction. Even though the tarball
 *  is ed25519-verified and only a super-admin can install, a malicious
 *  (or compromised) signed module shouldn't be able to write outside its
 *  target dir. Reject absolute paths, `..` traversal, and any symlink /
 *  hardlink / device member (the classic symlink-then-write escape).
 *  Returns an error string, or null if every member is a plain file or
 *  directory with a safe relative path. (Audit 2026-06-19 finding #8.) */
function auditTarballMembers(tmpTar: string): string | null {
  // `-tzvf` includes the type char (first column) + name; parse both.
  const listed = spawnSync("tar", ["-tzvf", tmpTar], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listed.status !== 0) {
    return `could not list tarball contents (tar exit ${listed.status})`;
  }
  const lines = (listed.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const typeChar = line[0];
    // 'd' dir, '-' regular file are the only allowed member types.
    // 'l' symlink, 'h' hardlink, 'b'/'c' device, 'p' fifo, 's' socket → reject.
    if (typeChar !== "d" && typeChar !== "-") {
      return `tarball contains a non-file member (type '${typeChar}') — refusing to extract`;
    }
    // Member name: GNU/BSD `tar -tv` puts " name" (and " name -> target"
    // for links, already rejected above) after the date/time columns.
    // Take everything after the first column-block; the absolute/`..`
    // check below is what matters and is robust to column spacing.
    const name = line.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, "").trim();
    if (name.startsWith("/") || name.startsWith("~")) {
      return `tarball member has an absolute path: ${name}`;
    }
    if (name.split("/").some((seg) => seg === "..")) {
      return `tarball member escapes its directory (..): ${name}`;
    }
  }
  return null;
}

sandboxInstallRouter.post("/install", async (req, res, next) => {
  try {
    const parsed = InstallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "name + version required", details: parsed.error.issues },
      });
      return;
    }
    const { name, version } = parsed.data;
    const registryUrl = parsed.data.registry_url ?? DEFAULT_REGISTRY;

    type RegistryShape = {
      modules: Array<{
        name: string;
        public_key_ed25519: string | null;
        versions: Array<{
          version: string;
          source_url: string;
          sha256: string | null;
          signature: string | null;
        }>;
      }>;
    };

    const registry = (await fetchGithubJson(registryUrl)) as RegistryShape;
    const modSpec = registry.modules.find((m) => m.name === name);
    if (!modSpec) {
      res.status(404).json({ error: { code: "not_in_registry", message: `${name} not in registry` } });
      return;
    }
    const versionSpec = modSpec.versions.find((v) => v.version === version);
    if (!versionSpec) {
      res.status(404).json({ error: { code: "version_not_found", message: `${name}@${version} not in registry` } });
      return;
    }
    if (!versionSpec.sha256 || !modSpec.public_key_ed25519 || !versionSpec.signature) {
      res.status(400).json({
        error: { code: "unsigned", message: "registry entry missing sha256 / public key / signature" },
      });
      return;
    }

    // TOFU key-pinning: a module's signing key is pinned on first install.
    // An update signed by a DIFFERENT key is rejected unless the operator
    // re-consents (allow_key_change) — this is what catches a hijacked
    // repo serving a re-signed malicious update under the same name.
    const prior = await meta
      .selectFrom("installed_modules")
      .select("signed_by")
      .where("name", "=", name)
      .executeTakeFirst();
    if (prior?.signed_by && prior.signed_by !== modSpec.public_key_ed25519 && !parsed.data.allow_key_change) {
      res.status(409).json({
        error: {
          code: "signing_key_changed",
          message: `${name}'s signing key changed since it was installed. Re-consent (allow_key_change) to accept the new key.`,
          details: { pinned: prior.signed_by, incoming: modSpec.public_key_ed25519 },
        },
      });
      return;
    }

    // Fetch + verify + extract.
    const tarball = await fetchGithubBuffer(versionSpec.source_url);
    const gotSha = createHash("sha256").update(tarball).digest("hex");
    if (gotSha !== versionSpec.sha256) {
      res.status(400).json({
        error: { code: "sha_mismatch", message: `sha256 mismatch: registry=${versionSpec.sha256} got=${gotSha}` },
      });
      return;
    }
    const sigB64 = versionSpec.signature.startsWith("ed25519:")
      ? versionSpec.signature.slice("ed25519:".length)
      : versionSpec.signature;
    if (!verifyEd25519(modSpec.public_key_ed25519, tarball, sigB64)) {
      res.status(400).json({
        error: { code: "bad_signature", message: "ed25519 signature did NOT verify" },
      });
      return;
    }

    // Extract to RUNTIME_INSTALL_DIR/<name>/. If any step after
    // `mkdirSync` fails (extract, manifest read, registration),
    // we tear down the targetDir so the next install isn't blocked
    // by a half-baked install + the loader doesn't pick up an
    // unregistered manifest at boot.
    const targetDir = joinPath(RUNTIME_INSTALL_DIR, name);
    const alreadyExisted = existsSync(targetDir);
    const rollback = (reason: string, status: number, code: string) => {
      if (!alreadyExisted) {
        try {
          rmSync(targetDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`[sandbox-install] rollback failed for ${targetDir}:`, err);
        }
      } else {
        console.warn(
          `[sandbox-install] ${name}@${version}: ${reason} — leaving ${targetDir} alone (pre-existing install)`,
        );
      }
      res.status(status).json({ error: { code, message: reason } });
    };
    mkdirSync(targetDir, { recursive: true });
    const tmpTar = joinPath(RUNTIME_INSTALL_DIR, `.install-${name}-${Date.now()}.tgz`);
    writeFileSync(tmpTar, tarball);
    // Audit members BEFORE extracting — reject path-traversal / symlink
    // escapes even from a signed tarball. (Audit 2026-06-19 finding #8.)
    const auditErr = auditTarballMembers(tmpTar);
    if (auditErr) {
      try { spawnSync("rm", ["-f", tmpTar]); } catch {/* ignore */}
      rollback(`unsafe tarball: ${auditErr}`, 400, "unsafe_tarball");
      return;
    }
    const tarRes = spawnSync("tar", [
      "-xzf", tmpTar,
      "-C", targetDir,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    try {
      spawnSync("rm", ["-f", tmpTar]);
    } catch {/* ignore */}
    if (tarRes.status !== 0) {
      rollback(`tar extract failed (exit ${tarRes.status})`, 500, "extract_failed");
      return;
    }

    // Register + mount the new module without restarting the api.
    const manifestPath = joinPath(targetDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      rollback("extracted tarball missing manifest.json", 400, "no_manifest");
      return;
    }
    let loaded;
    try {
      loaded = await loadOneSandboxedModule(targetDir);
    } catch (err) {
      rollback((err as Error).message, 400, "load_failed");
      return;
    }
    if (!loaded) {
      rollback("manifest loaded but registration failed", 500, "register_failed");
      return;
    }
    await mountNewlyRegistered(loaded.name);

    // Audit-trail: record the install in installed_modules.
    await meta
      .insertInto("installed_modules")
      .values({
        name: loaded.name,
        version: loaded.version,
        band: "marketplace",
        source: "registry",
        source_url: versionSpec.source_url,
        source_sha256: versionSpec.sha256,
        signed_by: modSpec.public_key_ed25519,
        manifest: sql`${JSON.stringify(loaded)}::jsonb` as never,
        installed_by: req.session!.id,
      })
      .onConflict((c) =>
        c.column("name").doUpdateSet({
          version: loaded.version,
          source: "registry",
          source_url: versionSpec.source_url,
          source_sha256: versionSpec.sha256,
          signed_by: modSpec.public_key_ed25519,
          manifest: sql`${JSON.stringify(loaded)}::jsonb` as never,
        }),
      )
      .execute();

    // The installed_modules row above IS the audit trail —
    // installed_by + installed_at land there. Skipping activity_log
    // because the helper requires orgId (cross-workspace platform
    // installs are intentionally not tied to a single workspace).

    res.status(201).json({
      ok: true,
      name: loaded.name,
      version: loaded.version,
      routes: loaded.routes.map((r) => ({ method: r.method, path: r.path })),
    });
  } catch (err) {
    next(err);
  }
});

/** Browse-the-registry helper for the UI. Returns the same modules.json
 *  the operator-curated registry serves, optionally annotated with
 *  installed-status from the local installed_modules table. */
sandboxInstallRouter.get("/registry", async (req, res, next) => {
  try {
    const registryUrl =
      (typeof req.query.url === "string" ? req.query.url : undefined) ?? DEFAULT_REGISTRY;
    let registry: { modules: Array<{ name: string }> };
    try {
      registry = (await fetchGithubJson(registryUrl)) as { modules: Array<{ name: string }> };
    } catch (e) {
      // An unreachable/misconfigured registry is an EXPECTED condition on
      // self-hosted/dev instances — answer 503 with a clear code instead of
      // bubbling an unhandled 500 (console audit, 2026-06-11). The web's
      // Marketplace section already renders a friendly banner off this.
      res.status(503).json({
        error: { code: "registry_unreachable", message: `Couldn't reach the module registry: ${(e as Error).message}` },
      });
      return;
    }
    const installedRows = await meta
      .selectFrom("installed_modules")
      .select(["name", "version", "source"])
      .execute();
    const installedByName = new Map(installedRows.map((r) => [r.name, r]));
    const items = registry.modules.map((m) => ({
      ...m,
      installed: installedByName.get(m.name) ?? null,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/** Uninstall a runtime-installed sandboxed module. Image-baked
 *  modules (those in /app/sandboxed-modules/ that came with the
 *  cobblr-core image) are intentionally NOT removable here — that
 *  requires an image rebuild. Workspace-admin installs from the
 *  registry land under /var/cobblr/sandboxed-modules/ and are
 *  freely removable.
 *
 *  Effect:
 *    - Retires any in-flight workers holding the wasm.
 *    - Drops the in-memory registry entry (mounted routes start
 *      returning 410 Gone for subsequent calls).
 *    - Removes the runtime-install dir on disk.
 *    - Deletes the installed_modules row.
 *
 *  Workspace `org_modules` rows that had this module enabled stay —
 *  the operator can choose to clean those up via super-admin's
 *  workspace module matrix if needed. */
sandboxInstallRouter.delete("/install/:name", async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      res.status(400).json({ error: { code: "bad_name", message: "invalid module name" } });
      return;
    }
    // Refuse to delete image-baked modules — those are part of the
    // distribution + need an image rebuild to remove. installed_modules
    // tells us which is which: source="registry" came via runtime
    // install; source="image" came from the cobblr-core image.
    const row = await meta
      .selectFrom("installed_modules")
      .select(["name", "source"])
      .where("name", "=", name)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_installed", message: `${name} is not installed` } });
      return;
    }
    if (row.source === "image") {
      res.status(409).json({
        error: {
          code: "image_baked",
          message: `${name} is image-baked — uninstall requires rebuilding the cobblr-core image with the module removed from cobblr-modules.json`,
        },
      });
      return;
    }
    const result = await uninstallSandboxedModule(name);
    await meta.deleteFrom("installed_modules").where("name", "=", name).execute();
    res.json({
      ok: true,
      name,
      removed_from_registry: result.removedFromRegistry,
      removed_dir: result.removedDir,
    });
  } catch (err) {
    next(err);
  }
});
