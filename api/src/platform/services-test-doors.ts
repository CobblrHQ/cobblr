// Services test doors (services.md §16): how the kernel's own tests reach it
// on a deployment whose job is to be tested, and NEVER on production or
// canary (testDoorsEnabled decides, the same rule as the camera page's).
//
//   - a built-in `test.echo`, whose input scenario drives every path a
//     built-in can take: done, a failure, an answer outside its schema, slow;
//   - `POST /orgs/:slug/services/test-connections`: a test hands the api a
//     conformance fake service it started (base URL + key) and it answers as
//     a service connection for that workspace, signed like any other. Held in
//     memory only: a restart forgets it, and nothing reaches a table.
//
// The Connections half's real port takes precedence for every connection it
// knows; these add to it, they never replace it.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { adapterGroupOf, parseServiceManifest, type ServiceManifest } from "@cobblr/platform-contract/services";
import { LIBRARY_CAPABILITY_DECLS, LIBRARY_FIND, LIBRARY_GET, type LibraryFindInput, type LibraryItem } from "@cobblr/platform-contract/library";
import { parseServiceKey, signServiceRequest, type ServiceKey } from "@cobblr/platform-contract/service-auth";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { adapterFetchFor } from "./service-connections.js";
import { supervise } from "./service-supervisor.js";
import { listBuiltIns, RETENTION_PASS, setServiceConnectionPort, type ServiceConnectionPort, type ServiceConnectionRef, type ServiceHopResponse } from "./services.js";
import { instantFromInput } from "@cobblr/platform-contract/day";

interface TestConnection {
  ref: ServiceConnectionRef;
  orgId: string;
  baseUrl: string;
  key: ServiceKey;
}

const byId = new Map<string, TestConnection>();
/** Adapter test connections' settings, by credential id: what configFor
 *  answers for them. */
const adapterConfigs = new Map<string, Record<string, string>>();
/** Who made each adapter test connection: whose bridge its fetch rides. */
const adapterOwners = new Map<string, string>();

async function hop(conn: TestConnection, req: { method: string; path: string; body?: Uint8Array | string; headers?: Record<string, string> }): Promise<ServiceHopResponse> {
  const pathAndQuery = `${conn.ref.manifest.api.base_path}${req.path}`;
  const body = req.body === undefined ? undefined : typeof req.body === "string" ? Buffer.from(req.body) : Buffer.from(req.body);
  const headers = { ...(req.headers ?? {}), ...signServiceRequest({ keyId: conn.key.keyId, secret: conn.key.secret, method: req.method, pathAndQuery, ...(body ? { body } : {}) }) };
  const res = await fetch(new URL(pathAndQuery, conn.baseUrl), { method: req.method, headers, ...(body ? { body } : {}) });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k] = v));
  return { status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) };
}

/** The test connections in front of whatever real port is registered. */
function overlay(real: ServiceConnectionPort | null): ServiceConnectionPort {
  const mine = (orgId: string) => [...byId.values()].filter((c) => c.orgId === orgId);
  return {
    chainFor: async (orgId, userId, capability, opts) => {
      const own = mine(orgId).filter((c) => (!opts?.via || c.ref.credentialId === opts.via) && c.ref.manifest.capabilities.some((x) => x.id === capability)).map((c) => c.ref);
      if (opts?.via && own.length) return own;
      return [...own, ...(real ? await real.chainFor(orgId, userId, capability, opts) : [])];
    },
    byId: async (id) => byId.get(id)?.ref ?? (real ? real.byId(id) : null),
    configFor: async (id) => adapterConfigs.get(id) ?? (real?.configFor ? real.configFor(id) : null),
    updateSecrets: async (id, group, expected, patch) => {
      if (!real?.updateSecrets || adapterConfigs.has(id)) throw new Error("This test connection cannot save refreshed credentials.");
      await real.updateSecrets(id, group, expected, patch);
    },
    adapterFetch: async (id) => {
      const config = adapterConfigs.get(id);
      if (config) return adapterFetchFor(config, adapterOwners.get(id) ?? "");
      return real?.adapterFetch ? real.adapterFetch(id) : null;
    },
    holders: async (orgId, capability) => [
      ...mine(orgId)
        .filter((c) => c.ref.manifest.capabilities.some((x) => x.id === capability))
        .map((c) => ({ credentialId: c.ref.credentialId, label: c.ref.label, ownerUserId: adapterOwners.get(c.ref.credentialId) ?? "", shared: true, provider: c.ref.adapter ?? c.ref.manifest.id })),
      ...(real?.holders ? await real.holders(orgId, capability) : []),
    ],
    list: async (orgId, userId) => [...mine(orgId).map((c) => c.ref), ...(real ? await real.list(orgId, userId) : [])],
    fetch: async (id, req) => {
      const t = byId.get(id);
      if (t) return hop(t, req);
      if (!real) throw new Error("services: no such connection");
      return real.fetch(id, req);
    },
  };
}

const Body = z.object({ base_url: z.string().url(), key: z.string().min(3).max(400), label: z.string().max(80).optional() });
/** An adapter's connection: which built-in, and its settings. */
// A config value is a URL or a key, or for the test document system a list of
// items as JSON, which is longer.
const AdapterBody = z.object({ adapter: z.string().min(1).max(120), config: z.record(z.string().max(8000)), label: z.string().max(80).optional() });

export const servicesTestRouter = Router({ mergeParams: true });

// AI-REACH: exempt (a test door: closed on production and canary)
servicesTestRouter.post("/:slug/services/test-connections", requireAuth, withTenant, async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const a = AdapterBody.safeParse(req.body ?? {});
  if (a.success) {
    // An adapter is named by its group (or its one built-in's id): every
    // built-in of the group answers on the one connection.
    const defs = listBuiltIns().filter((d) => d.connection && (adapterGroupOf(d) === a.data.adapter || d.id === a.data.adapter));
    const def = defs[0];
    if (!def) {
      res.status(404).json({ error: { code: "no_adapter", message: `no adapter ${a.data.adapter}` } });
      return;
    }
    const credentialId = `test:${crypto.randomUUID()}`;
    const manifest: ServiceManifest = {
      cobblr_service: 1,
      id: `adapter.${adapterGroupOf(def)}`,
      name: def.name,
      version: "adapter",
      auth: { schemes: ["adapter"] },
      api: { base_path: "/" },
      capabilities: defs.map((d) => d.capability),
    };
    adapterConfigs.set(credentialId, a.data.config);
    adapterOwners.set(credentialId, req.session!.id);
    byId.set(credentialId, {
      orgId: req.tenant!.org.id,
      baseUrl: "http://adapter.invalid",
      key: { keyId: "adapter", secret: "adapter" } as ServiceKey,
      ref: { credentialId, label: a.data.label ?? def.name, scope: "personal", manifest, manifestVersion: "test", adapter: adapterGroupOf(def) },
    });
    res.status(201).json({ credential_id: credentialId, capabilities: defs.map((d) => d.capability.id) });
    return;
  }
  const b = Body.safeParse(req.body ?? {});
  const key = b.success ? parseServiceKey(b.data.key) : null;
  if (!b.success || !key) {
    res.status(400).json({ error: { code: "invalid_body", message: "base_url and a <key_id>.<secret> key are required" } });
    return;
  }
  const base = new URL(b.data.base_url);
  const got = await fetch(new URL("/.well-known/cobblr-service.json", base.origin)).catch(() => null);
  const parsed = got?.ok ? parseServiceManifest(await got.json()) : null;
  if (!parsed?.ok) {
    res.status(400).json({ error: { code: "bad_manifest", message: parsed ? parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ") : "no manifest at that address" } });
    return;
  }
  const manifest: ServiceManifest = parsed.manifest;
  const credentialId = `test:${crypto.randomUUID()}`;
  byId.set(credentialId, {
    orgId: req.tenant!.org.id,
    baseUrl: base.origin,
    key,
    ref: { credentialId, label: b.data.label ?? manifest.name, scope: "personal", manifest, manifestVersion: "test" },
  });
  res.status(201).json({ credential_id: credentialId, capabilities: manifest.capabilities.map((c) => c.id) });
});

// AI-REACH: exempt (a test door: closed on production and canary)
servicesTestRouter.post("/:slug/services/test-retention", requireAuth, withTenant, async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const now = instantFromInput(req.body?.now) ?? new Date();
  const result = await platform().sweeps.run(RETENTION_PASS, { orgIds: [req.tenant!.org.id], now });
  // A pass that never ran must not answer as if it had.
  if (result.skipped) {
    res.status(409).json({ error: { code: "lock_held", message: "the retention pass's lock stayed held; it did not run" } });
    return;
  }
  res.json(result);
});

// AI-REACH: exempt (a test door: closed on production and canary)
servicesTestRouter.post("/:slug/services/test-module-jobs", requireAuth, withTenant, async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const b = (req.body ?? {}) as { capability?: string; input?: unknown; caused_by_job?: string };
  if (!b.capability) {
    res.status(400).json({ error: { code: "invalid_body", message: "capability required" } });
    return;
  }
  try {
    const ref = await platform().services.invoke({ orgId: req.tenant!.org.id, capability: b.capability, input: b.input ?? {}, ...(b.caused_by_job ? { causedByJob: b.caused_by_job } : {}) });
    res.status(202).json(ref);
  } catch (err) {
    if (err instanceof Error && err.name === "ServiceRefused") {
      res.status(403).json({ error: { code: "refused", message: err.message } });
      return;
    }
    throw err;
  }
});

// AI-REACH: exempt (a test door: closed on production and canary)
servicesTestRouter.post("/:slug/services/test-supervise", requireAuth, withTenant, async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const now = instantFromInput(req.body?.now) ?? new Date();
  res.json(await supervise(req.tenant!.org.id, now));
});

let registered = false;
/** Open the test doors: the built-in and the test connections. Called at
 *  boot only where test doors are open. */
export function openServicesTestDoors(realPort: ServiceConnectionPort | null): void {
  if (registered) return;
  registered = true;
  setServiceConnectionPort(overlay(realPort));
  platform().services.registerBuiltIn({
    id: "platform.test-echo",
    name: "Test echo",
    capability: {
      id: "test.echo",
      version: 1,
      title: "Echo (test)",
      summary: "Answers with what it was given. A test door; never on a production deployment.",
      effect: "none",
      mode: "async",
      input_schema: { type: "object", properties: { scenario: { enum: ["done", "fail", "bad_output", "slow"] }, text: { type: "string" }, ms: { type: "number" } }, required: ["scenario"] },
      output_schema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false },
    },
    run: async ({ input, progress }) => {
      const i = input as { scenario: string; text?: string; ms?: number };
      if (i.scenario === "fail") throw new Error("the test echo was asked to fail");
      if (i.scenario === "slow") {
        await progress(0.5, "halfway");
        await new Promise((r) => setTimeout(r, Math.min(Number(i.ms) || 1000, 30_000)));
      }
      if (i.scenario === "bad_output") return { output: { echo: 42, extra: true } };
      return { output: { echo: i.text ?? "" } };
    },
  });
  // Acts in the physical world, as far as consent knows: every door must hold
  // it for a person's yes (service-consent.ts). Pressing it changes nothing.
  platform().services.registerBuiltIn({
    id: "platform.test-press",
    name: "Test press",
    capability: {
      id: "test.press",
      version: 1,
      title: "Press (test)",
      summary: "Stands in for something that acts in the physical world. A test door; never on a production deployment.",
      effect: "physical",
      mode: "async",
      input_schema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
      output_schema: { type: "object", properties: { pressed: { type: "string" } }, required: ["pressed"], additionalProperties: false },
    },
    run: async ({ input }) => ({ output: { pressed: String((input as { what: string }).what) } }),
  });
  platform().services.registerBuiltIn({
    id: "platform.test-adapter",
    name: "Test adapter",
    capability: {
      id: "test.adapt",
      version: 1,
      title: "Adapter (test)",
      summary: "Answers with which connection's settings it ran on, never the secret. A test door; never on a production deployment.",
      effect: "none",
      mode: "sync",
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "object", properties: { site: { type: "string" }, key_length: { type: "number" } }, required: ["site"] },
    },
    connection: {
      title: "Test adapter",
      config_schema: {
        type: "object",
        properties: { site: { type: "string", title: "Which site" }, token: { type: "string", title: "Token", writeOnly: true } },
        required: ["site", "token"],
      },
      test: async (config) => (config.token ? { ok: true, note: `site ${config.site}` } : { ok: false, reason: "invalid_key", error: "no token" }),
    },
    run: async ({ config }) => ({ output: { site: config?.site ?? "", key_length: (config?.token ?? "").length } }),
  });
  platform().services.registerBuiltIn({
    id: "platform.test-refresh", name: "Test credential refresh",
    capability: {
      id: "test.refresh", version: 1, title: "Refresh (test)",
      summary: "Checks a recorded credential rotation without contacting a provider.",
      effect: "none", mode: "sync",
      input_schema: { type: "object", properties: { refresh: { type: "boolean" } } },
      output_schema: { type: "object", properties: { refreshed: { type: "boolean" } }, required: ["refreshed"], additionalProperties: false },
    },
    connection: {
      title: "Test credential refresh",
      config_schema: { type: "object", properties: {
        site: { type: "string", title: "Site" },
        access_token: { type: "string", title: "Access token", writeOnly: true },
        refresh_token: { type: "string", title: "Refresh token", writeOnly: true },
      } },
      test: async () => ({ ok: true }),
    },
    run: async ctx => {
      if ((ctx.input as { refresh?: boolean }).refresh) {
        if (!ctx.updateSecrets) throw new Error("This connection cannot save refreshed credentials.");
        await ctx.updateSecrets({ access_token: "recorded-rotated-access", refresh_token: "recorded-rotated-refresh" });
      }
      return { output: { refreshed: ctx.config?.access_token === "recorded-rotated-access" && ctx.config?.refresh_token === "recorded-rotated-refresh" } };
    },
  });
  // A library core-documents has never heard of, for the proof that
  // library.* is generic: a stub with no code of its own anywhere else,
  // answering find and get from the items its connection was given (config
  // `items`, JSON), whatever they are. The bar of #4489: a third library
  // needs an adapter and nothing else.
  const stubItems = (config: Record<string, string> | undefined): LibraryItem[] => {
    try {
      return JSON.parse(config?.items ?? config?.documents ?? "[]") as LibraryItem[];
    } catch {
      return [];
    }
  };
  const stubConnection = {
    title: "Test library",
    group: "test-library",
    config_schema: {
      type: "object" as const,
      properties: { items: { type: "string" as const, title: "Items (JSON)" }, token: { type: "string" as const, title: "Token", writeOnly: true as const } },
      required: ["items"],
    },
    test: async () => ({ ok: true, note: "test library" }),
  };
  platform().services.registerBuiltIn({
    id: "platform.test-library-find",
    name: "Test library",
    capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_FIND],
    connection: stubConnection,
    run: async ({ input, config }) => {
      const i = (input ?? {}) as LibraryFindInput;
      const all = stubItems(config);
      if (i.since) return { output: { items: all } };
      const words = `${i.query ?? ""} ${i.facts?.name ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      return { output: { items: all.filter((d) => words.some((w) => `${d.title} ${d.excerpt ?? ""}`.toLowerCase().includes(w))) } };
    },
  });
  platform().services.registerBuiltIn({
    id: "platform.test-library-get",
    name: "Test library",
    capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_GET],
    connection: stubConnection,
    run: async ({ input, config }) => {
      const ref = String((input as { ref?: unknown })?.ref ?? "");
      const item = stubItems(config).find((d) => d.ref === ref);
      if (!item) throw new Error("no such item");
      return { output: { item, thumb: null } };
    },
  });
  platform().services.registerBuiltIn({
    id: "platform.test-now",
    name: "Test now",
    capability: {
      id: "test.now",
      version: 1,
      title: "Answer now (test)",
      summary: "A sync capability: answers inside the call. A test door; never on a production deployment.",
      effect: "none",
      mode: "sync",
      input_schema: { type: "object", properties: { text: { type: "string" } } },
      output_schema: { type: "object", properties: { said: { type: "string" } }, required: ["said"] },
    },
    run: async ({ input }) => {
      const text: unknown = (input as Record<string, unknown> | null)?.["text"];
      return { output: { said: typeof text === "string" ? text : "" } };
    },
  });
}
