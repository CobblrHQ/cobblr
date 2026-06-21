// Discovers sandboxed wasm modules from sandboxed-modules/<name>/
// and registers them with the existing module registry as if they
// were in-process modules. The synthetic api() returns an Express
// Router whose routes invoke the wasm via the sandbox runtime.
//
// Why piggyback on the existing registry instead of building a
// parallel one: a workspace's "Modules" page, the super-admin
// view, org_modules toggling, tenant migrations — all of these
// already query the registry. Sandboxed modules joining there
// means none of that has to change.

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { defineModule } from "@cobblr/platform-contract";
import { deregister, get as getRegisteredModule, getEntry as getRegistryEntry, register } from "../modules/registry.js";
import { ABI_VERSION, SandboxedModuleManifestSchema, type SandboxedModuleManifest } from "./abi.js";
import { invokeSandbox } from "./runtime.js";
import { retireWorkersForWasmPath } from "./pool.js";
import { setSandboxedModuleInfo, deleteSandboxedModuleInfo } from "./sandboxed-module-info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOXED_MODULES_DIR = resolve(__dirname, "..", "..", "..", "sandboxed-modules");
/** Persistent runtime-installed sandboxed modules. Mounted as a
 *  volume in prod docker-compose so install survives api restart. */
export const RUNTIME_INSTALL_DIR =
  process.env.COBBLR_RUNTIME_MODULES_DIR ?? "/var/cobblr/sandboxed-modules";

interface ParsedManifest {
  manifest: SandboxedModuleManifest;
  rootPath: string;
  wasmPath: string;
}

/** The repo's baked-in `sandboxed-modules/` are DEMOS/fixtures (hello-as,
 *  hello-wasm, url-archive, bricklink-sandboxed) that exist to exercise the wasm
 *  sandbox path — not modules for real workspaces. Loading them in a real instance
 *  just clutters the Modules view and mounts demo routes, so they load ONLY behind
 *  an explicit opt-in: `COBBLR_LOAD_EXAMPLE_MODULES=1`. CI's test job sets it (the
 *  sandbox integration tests hit the built api as a plain `node` process, where
 *  VITEST/NODE_ENV aren't "test"); dev sets it to tinker. Real user-installed
 *  sandbox modules live in RUNTIME_INSTALL_DIR and always load. (An already-enabled
 *  demo row in an org is harmless once unregistered: the modules API joins on the
 *  registry and migrations skip unknown modules, so it just drops out of view.) */
const LOAD_EXAMPLE_MODULES = process.env.COBBLR_LOAD_EXAMPLE_MODULES === "1";

export async function loadAllSandboxedModules(): Promise<{ count: number; names: string[] }> {
  const loaded: string[] = [];
  // The persistent runtime-install dir (marketplace installs, mounted as a volume
  // in prod) always loads; the repo demo dir only under test/dev opt-in.
  const dirs = LOAD_EXAMPLE_MODULES
    ? [SANDBOXED_MODULES_DIR, RUNTIME_INSTALL_DIR]
    : [RUNTIME_INSTALL_DIR];
  for (const dir of dirs) {
    const scanned = await scanDir(dir);
    for (const name of scanned) loaded.push(name);
  }

  console.log(
    `[sandbox] registered ${loaded.length} sandboxed module(s): ${loaded.join(", ") || "(none)"}`,
  );
  return { count: loaded.length, names: loaded };
}

async function scanDir(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const loaded: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const rootPath = join(dir, entry);
    const stats = await stat(rootPath).catch(() => null);
    if (!stats?.isDirectory()) continue;

    const parsed = await tryParse(rootPath, entry);
    if (!parsed) continue;
    if (parsed.manifest.abi_version > ABI_VERSION) {
      console.error(
        `[sandbox] ${parsed.manifest.name}: abi_version ${parsed.manifest.abi_version} > host ABI ${ABI_VERSION} — skipping`,
      );
      continue;
    }
    try {
      await registerAsModule(parsed);
      loaded.push(parsed.manifest.name);
      if (process.env.NODE_ENV !== "production") {
        watchWasmForReload(parsed.wasmPath, parsed.manifest.name);
      }
    } catch (err) {
      console.error(`[sandbox] failed to register ${parsed.manifest.name}:`, err);
    }
  }
  return loaded;
}

/** Used by the runtime-uninstall endpoint to remove a sandboxed
 *  module's runtime artifacts. Retires any live workers, drops the
 *  in-memory registry entry, and (if the module was runtime-
 *  installed) removes the on-disk dir. Image-baked modules are
 *  preserved on disk — the registry deregister + worker retire
 *  still happen so future requests 410 until restart.
 *
 *  Returns a summary of what was cleaned up. */
export async function uninstallSandboxedModule(name: string): Promise<{
  removedFromRegistry: boolean;
  removedDir: string | null;
}> {
  const entry = getRegistryEntry(name);
  let removedDir: string | null = null;
  // Find the runtime dir (if any) for this module.
  const runtimeDir = join(RUNTIME_INSTALL_DIR, name);
  const runtimeStat = await stat(runtimeDir).catch(() => null);
  if (runtimeStat?.isDirectory()) {
    try {
      await rm(runtimeDir, { recursive: true, force: true });
      removedDir = runtimeDir;
    } catch (err) {
      console.error(`[sandbox] uninstall ${name}: rm ${runtimeDir} failed:`, err);
    }
  }
  // Retire any pooled workers holding the wasm. The pool keys by
  // wasmPath; for a uninstalled module the path was in either the
  // runtime dir (gone) or the image-baked dir.
  if (entry) {
    const wasmPath = join(entry.rootPath, "module.wasm");
    retireWorkersForWasmPath(wasmPath);
  }
  deleteSandboxedModuleInfo(name);
  const removedFromRegistry = deregister(name);
  return { removedFromRegistry, removedDir };
}

/** Used by the runtime-install endpoint to register + mount a
 *  freshly-extracted sandboxed module without a process restart.
 *  Returns the parsed manifest on success. */
export async function loadOneSandboxedModule(rootPath: string): Promise<SandboxedModuleManifest | null> {
  const parsed = await tryParse(rootPath, rootPath.split("/").pop() ?? rootPath);
  if (!parsed) return null;
  if (parsed.manifest.abi_version > ABI_VERSION) {
    throw new Error(
      `${parsed.manifest.name}: abi_version ${parsed.manifest.abi_version} > host ABI ${ABI_VERSION}`,
    );
  }
  await registerAsModule(parsed);
  if (process.env.NODE_ENV !== "production") {
    watchWasmForReload(parsed.wasmPath, parsed.manifest.name);
  }
  return parsed.manifest;
}

const SANDBOX_MAX_DEADLINE_MS = Number(process.env.SANDBOX_MAX_DEADLINE_MS ?? 30_000);
// Default deadline for a route that doesn't declare its own. 1000ms is a fine
// PROD latency budget, but the Forgejo CI runner (heavily contended under the
// 8-fork suite) makes the host↔worker SharedArrayBuffer round-trip far slower,
// so a legit op can blow 1000ms → spurious `sandbox_deadline` flakes (e.g.
// url-archive's clear). Env-tunable so CI can be generous (same rationale as the
// 60s testTimeout) while prod keeps the tight default. Previously hardcoded —
// the env knob existed in pool.ts but never reached this route path.
const SANDBOX_DEFAULT_DEADLINE_MS = Number(process.env.SANDBOX_DEFAULT_DEADLINE_MS ?? 1000);

/** Flatten the manifest's `reads` map into a Set of fully-qualified
 *  table names the host can match in O(1). Example:
 *    { "inventory": ["parts"] } → Set { "inventory_parts" } */
function buildAllowedReadTables(reads: Record<string, string[]> | undefined): Set<string> | undefined {
  if (!reads) return undefined;
  const out = new Set<string>();
  for (const [mod, tables] of Object.entries(reads)) {
    const modPrefix = mod.replace(/-/g, "_");
    for (const t of tables) out.add(`${modPrefix}_${t}`);
  }
  return out;
}


function clampDeadline(requested: number | undefined): number {
  if (requested === undefined) return SANDBOX_DEFAULT_DEADLINE_MS;
  if (requested < 100) return 100;
  if (requested > SANDBOX_MAX_DEADLINE_MS) return SANDBOX_MAX_DEADLINE_MS;
  return requested;
}

// Coalesce burst-of-writes (compilers tend to write multiple times
// during a build) into a single retire-and-reload event.
const reloadTimers = new Map<string, NodeJS.Timeout>();

function watchWasmForReload(wasmPath: string, moduleName: string): void {
  try {
    watch(wasmPath, { persistent: false }, () => {
      // Debounce — module.wasm gets several writes during a build.
      const existing = reloadTimers.get(wasmPath);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        reloadTimers.delete(wasmPath);
        const n = retireWorkersForWasmPath(wasmPath);
        if (n > 0) {
          console.log(`[sandbox] hot-reload: retired ${n} worker(s) for ${moduleName}`);
        }
      }, 300);
      reloadTimers.set(wasmPath, timer);
    });
  } catch (err) {
    console.warn(`[sandbox] could not watch ${wasmPath} for hot-reload:`, err);
  }
}

async function tryParse(rootPath: string, entry: string): Promise<ParsedManifest | null> {
  const manifestPath = join(rootPath, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    console.error(`[sandbox] ${entry}: no manifest.json — skipping`);
    return null;
  }
  let parsed: SandboxedModuleManifest;
  try {
    const raw_obj = JSON.parse(raw);
    const validated = SandboxedModuleManifestSchema.safeParse(raw_obj);
    if (!validated.success) {
      const summary = validated.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      console.error(`[sandbox] ${entry}: manifest validation failed: ${summary}`);
      return null;
    }
    parsed = validated.data as SandboxedModuleManifest;
  } catch (err) {
    console.error(`[sandbox] ${entry}: invalid manifest.json:`, err);
    return null;
  }
  const wasmPath = join(rootPath, "module.wasm");
  const wasmStat = await stat(wasmPath).catch(() => null);
  if (!wasmStat?.isFile()) {
    console.error(`[sandbox] ${entry}: missing module.wasm`);
    return null;
  }
  return { manifest: parsed, rootPath, wasmPath };
}

/** Synthesize a ModuleManifest from the sandboxed manifest + an
 *  Express router whose routes invoke the wasm. */
async function registerAsModule(parsed: ParsedManifest): Promise<void> {
  const router = buildRouter(parsed);
  // Record what the per-module Postgres role needs: this module's table
  // prefix + the cross-module tables it may SELECT. (sandbox/module-role.ts)
  setSandboxedModuleInfo(parsed.manifest.name, {
    prefix: `${parsed.manifest.name.replace(/-/g, "_")}_`,
    readsTables: [...(buildAllowedReadTables(parsed.manifest.reads) ?? new Set<string>())],
  });
  // If the module ships migrations, advertise them on the synthetic
  // manifest so the existing tenant-migration runner (in enable.ts)
  // picks them up. Table prefix follows the module-name convention.
  const migrationsDir = join(parsed.rootPath, "migrations");
  const hasMigrations = await stat(migrationsDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const schema = hasMigrations
    ? {
        tablePrefix: `${parsed.manifest.name.replace(/-/g, "_")}_`,
        migrationsDir: "migrations",
      }
    : undefined;
  const synthetic = defineModule({
    name: parsed.manifest.name,
    version: parsed.manifest.version,
    displayName: parsed.manifest.displayName,
    description: parsed.manifest.description,
    band: parsed.manifest.band,
    schema,
    api: () => Promise.resolve({ default: router }),
    intents: [],
    dependencies: [],
    provides: { entityKinds: [] },
    exposes: { events: [], api: [], actions: [] },
    subscribes: [],
  });
  register({ manifest: synthetic, rootPath: parsed.rootPath });
}

function buildRouter(parsed: ParsedManifest): Router {
  const router = Router({ mergeParams: true });
  // Gate every handler on the module still being registered.
  // Uninstall calls deregister() but Express doesn't unmount the
  // router; this check is the runtime stand-in.
  router.use((_req, res, next) => {
    if (!getRegisteredModule(parsed.manifest.name)) {
      res.status(410).json({
        error: { code: "module_uninstalled", message: `${parsed.manifest.name} was uninstalled — restart the api to clear the route` },
      });
      return;
    }
    next();
  });
  for (const route of parsed.manifest.routes) {
    const method = route.method.toLowerCase() as "get" | "post" | "patch" | "delete";
    router[method](route.path, async (req, res, next) => {
      try {
        const tenant = (req as unknown as {
          tenant?: { org: { id: string } };
        }).tenant;
        const session = (req as unknown as {
          session?: { id: string };
        }).session;
        if (!tenant || !session) {
          res.status(500).json({
            error: { code: "no_tenant", message: "tenant/session middleware not applied" },
          });
          return;
        }
        const result = await invokeSandbox(route.handler, {
          orgId: tenant.org.id,
          userId: session.id,
          moduleName: parsed.manifest.name,
          wasmPath: parsed.wasmPath,
          maxMemoryPages: parsed.manifest.max_memory_pages,
          deadlineMs: clampDeadline(route.deadline_ms),
          network: parsed.manifest.network,
          tablePrefix: `${parsed.manifest.name.replace(/-/g, "_")}_`,
          allowedReadTables: buildAllowedReadTables(parsed.manifest.reads),
          request: {
            body: req.body,
            query: Object.fromEntries(
              Object.entries(req.query).map(([k, v]) => [k, String(v)]),
            ),
            route: route.path,
          },
        });
        if (!result.ok) {
          let status = 500;
          let code = "sandbox_error";
          if (result.cpuQuotaExceeded) {
            status = 429;
            code = "cpu_quota_exceeded";
          } else if (result.concurrencyExceeded) {
            status = 429;
            code = "concurrency_exceeded";
          } else if (result.poolExhausted) {
            status = 503;
            code = "pool_exhausted";
          } else if (result.terminated) {
            status = 504;
            code = "sandbox_deadline";
          }
          res.status(status).json({
            error: { code, message: result.error ?? "sandbox invocation failed" },
            logs: result.logs,
          });
          return;
        }
        // If the wasm called HOST_RESPOND, emit its body verbatim.
        if (result.responseBody !== undefined) {
          res.status(result.responseStatus ?? 200);
          res.setHeader("Content-Type", "application/json");
          res.send(result.responseBody);
          return;
        }
        res.json({
          ok: true,
          logs: result.logs,
          kernel_calls: result.kernelCalls,
        });
      } catch (err) {
        next(err);
      }
    });
  }
  return router;
}
