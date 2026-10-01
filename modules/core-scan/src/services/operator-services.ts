// The instance's own barcode lookup and photo identify, as built-in services
// (services.md §12): `barcode.lookup` and `identify.image`.
//
// They were operator infrastructure reached through env-set URLs and nothing
// else, so a self-hoster with a better catalogue or their own vision model had
// no way to put it in front, and Cobb could not look a code up on request. As
// built-ins they are capabilities like any connected service: a connected
// service offering the same capability can answer first (the order is the
// kernel's), and these answer when nothing else does.
//
// No behaviour change on the hosted product: each wraps the function the scan
// flow already calls (lookupBarcode, hostedIdentifyWhy), with its allowance,
// entitlement and metering, and adds nothing of its own.

import { noteIdentification } from "./activation.js";
import { randomUUID } from "node:crypto";
import type { BuiltInServiceDef } from "@cobblr/platform-contract/services";
import { platform } from "@cobblr/platform-contract";
import { lookupBarcode, type BarcodeOutcome } from "./barcode-lookup.js";
import { hostedIdentifyWhy } from "./hosted-identify.js";

export interface OperatorServiceDeps {
  lookup: (code: string) => Promise<BarcodeOutcome>;
  identify: typeof hostedIdentifyWhy;
  readFile: (orgId: string, fileId: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}
const REAL: OperatorServiceDeps = {
  lookup: lookupBarcode,
  identify: hostedIdentifyWhy,
  readFile: (orgId, fileId) => platform().files.read(orgId, fileId),
};

/** Words a person reads when a lookup could not be answered right now. */
const UNRESOLVED: Record<string, string> = {
  rate_limited: "The barcode catalogue is busy right now. Try again in a little while.",
  auth: "The barcode catalogue refused this instance's key.",
  unreachable: "The barcode catalogue could not be reached.",
};

export function barcodeLookupBuiltIn(deps: OperatorServiceDeps = REAL): BuiltInServiceDef {
  return {
    id: "platform.barcode",
    name: "Barcode catalogue",
    capability: {
      id: "barcode.lookup",
      version: 1,
      title: "Look up a barcode",
      summary: "Finds the product a UPC, EAN or ISBN names: its title, brand, category and a picture. A miss means no catalogue knows the code.",
      effect: "none",
      mode: "sync",
      input_schema: { type: "object", properties: { code: { type: "string", title: "The barcode's digits" } }, required: ["code"], additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          title: { type: ["string", "null"] },
          brand: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          image_url: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          fields: { type: "object" },
        },
        required: ["found"],
      },
    },
    async run(ctx) {
      const code = String((ctx.input as { code?: unknown } | null)?.code ?? "").trim();
      if (!code) throw new Error("Say which barcode to look up.");
      const o = await deps.lookup(code);
      if (o.outcome === "hit") {
        const h = o.hit;
        return {
          output: {
            found: true,
            title: h.title,
            brand: h.brand,
            model: h.model,
            category: h.category,
            description: h.description,
            image_url: h.image_url,
            source: h.source,
            ...(h.fields ? { fields: h.fields } : {}),
          },
        };
      }
      if (o.outcome === "miss") return { output: { found: false } };
      // Unresolved is not absent: a failed job, never a "not found" that a
      // caller could cache as the answer.
      throw new Error(UNRESOLVED[o.outcome === "rate_limited" ? "rate_limited" : o.reason] ?? "The barcode catalogue could not answer.");
    },
  };
}

const DEGRADED: Record<string, string> = {
  off: "Photo identify is not set up on this instance.",
  scope: "Photo identify is not offered to this workspace.",
  plan: "This workspace's plan does not include photo identify.",
  allowance: "Photo identify is used up for today.",
  unreachable: "The photo identify service could not be reached.",
};

export function identifyImageBuiltIn(deps: OperatorServiceDeps = REAL): BuiltInServiceDef {
  return {
    id: "platform.identify",
    name: "Photo identify",
    capability: {
      id: "identify.image",
      version: 1,
      title: "Identify a photo",
      summary: "Says what a photo shows: a product (name, brand, category), a receipt (vendor, date, lines), or that it cannot tell. A barcode seen in the photo helps.",
      effect: "none",
      mode: "sync",
      input_schema: { type: "object", properties: { barcode: { type: "string", title: "A barcode on the thing, if known" } }, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: { kind: { enum: ["item", "receipt", "person", "unidentifiable"] }, source: { type: ["string", "null"] }, item: { type: "object" }, receipt: { type: "object" } },
        required: ["kind"],
      },
      files_in: [{ name: "image", types: ["image/jpeg", "image/png", "image/webp", "image/heic"], required: true }],
    },
    async run(ctx) {
      const fileId = ctx.files.image;
      if (!fileId) throw new Error("Give the photo to identify.");
      const file = await deps.readFile(ctx.orgId, fileId);
      if (!file) throw new Error("That photo could not be read.");
      const barcode = (ctx.input as { barcode?: unknown } | null)?.barcode;
      // No person on a job: the call meters against the workspace, the way
      // detached scan work already does.
      const { answer, degraded } = await deps.identify({
        orgId: ctx.orgId,
        imageB64: Buffer.from(file.bytes).toString("base64"),
        barcode: typeof barcode === "string" && barcode.trim() ? barcode.trim() : null,
      });
      if (!answer) throw new Error(DEGRADED[degraded ?? "unreachable"] ?? DEGRADED.unreachable!);
      return { output: answer };
    },
  };
}

let registered = false;
/** Register both, once. Photo identify only where the instance offers it: an
 *  instance with no identify service configured has nothing to put behind the
 *  capability, and listing it would promise what no call can keep. */
export function registerOperatorServices(): void {
  if (registered) return;
  registered = true;
  platform().services.registerBuiltIn(barcodeLookupBuiltIn());
  if (process.env.COBBLR_IDENTIFY_URL?.trim()) platform().services.registerBuiltIn(identifyImageBuiltIn());
}

// ── The scan flow asks the capability ────────────────────────────────────
//
// A self-hoster who connects their own barcode catalogue or vision service
// puts it first in the order, and the scan flow must then ask it. When the
// order's first answer is this instance's own built-in (every workspace that
// connected nothing, which is the whole hosted product), the scan flow calls
// the same function it always did, directly, so nothing about it changes:
// not the result's detail, not the caching, not the metering.

export interface ConnectedFirstDeps {
  firstStep(orgId: string, capability: string): Promise<{ source: "connection" | "built-in"; credential_id?: string; label: string } | null>;
  invoke(req: { orgId: string; capability: string; input: unknown; files?: Record<string, string>; via: { credentialId: string }; idempotencyKey: string }): Promise<{ id: string; status: string }>;
  output(orgId: string, jobId: string): Promise<unknown>;
  writeFile(orgId: string, bytes: Uint8Array, mimeType: string): Promise<string | null>;
}
const REAL_CONNECTED: ConnectedFirstDeps = {
  firstStep: async (orgId, capability) => (await platform().services.chainFor(orgId, null, capability)).steps[0] ?? null,
  invoke: (req) => platform().services.invoke(req),
  output: async (orgId, jobId) => (await platform().services.job(orgId, jobId))?.output ?? null,
  writeFile: async (orgId, bytes, mimeType) => (await platform().files.write(orgId, bytes, { mimeType, filename: "scan-photo" }))?.fileId ?? null,
};

/** A connected service's answer, when one is first in this workspace's order
 *  and answers. Null means "ask the instance's own", which is also what a
 *  connected service that fails or is still working after the inline budget
 *  gets: the scan never waits longer, or does worse, for having one. */
async function askConnectedFirst(
  orgId: string,
  capability: string,
  input: unknown,
  deps: ConnectedFirstDeps,
  files?: () => Promise<Record<string, string> | null>,
): Promise<{ label: string; output: unknown } | null> {
  let first;
  try {
    first = await deps.firstStep(orgId, capability);
  } catch {
    return null;
  }
  if (!first || first.source !== "connection" || !first.credential_id) return null;
  try {
    const f = files ? await files() : undefined;
    if (files && !f) return null;
    const ref = await deps.invoke({
      orgId,
      capability,
      input,
      ...(f ? { files: f } : {}),
      via: { credentialId: first.credential_id },
      // Every scan asks afresh: the same code a minute later is a new question.
      idempotencyKey: randomUUID(),
    });
    if (ref.status !== "done") {
      console.log(`[services] ${capability} on ${first.label}: ${ref.status}, answering from this instance`);
      return null;
    }
    return { label: first.label, output: await deps.output(orgId, ref.id) };
  } catch (err) {
    console.log(`[services] ${capability} on ${first.label} failed (${(err as Error).message}), answering from this instance`);
    return null;
  }
}

/** lookupBarcode, asked of this workspace's order first. */
export async function lookupBarcodeFor(orgId: string, code: string, deps: ConnectedFirstDeps = REAL_CONNECTED, direct = lookupBarcode): Promise<BarcodeOutcome> {
  const out = await lookupBarcodeForUncounted(orgId, code, deps, direct);
  if (out.outcome === "hit" || out.outcome === "miss") noteIdentification(orgId, "barcode", out.outcome === "hit");
  return out;
}

async function lookupBarcodeForUncounted(orgId: string, code: string, deps: ConnectedFirstDeps, direct: typeof lookupBarcode): Promise<BarcodeOutcome> {
  const asked = await askConnectedFirst(orgId, "barcode.lookup", { code }, deps);
  if (!asked) return direct(code);
  const o = (asked.output ?? {}) as Record<string, unknown>;
  if (o.found !== true || typeof o.title !== "string" || !o.title.trim()) return { outcome: "miss" };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    outcome: "hit",
    hit: {
      source: asked.label,
      title: o.title,
      brand: str(o.brand),
      model: str(o.model),
      description: str(o.description),
      category: str(o.category),
      image_url: str(o.image_url),
      raw: { service: asked.label },
    },
  };
}

/** hostedIdentifyWhy, asked of this workspace's order first. */
export async function identifyWhyFor(
  opts: Parameters<typeof hostedIdentifyWhy>[0] & { mimeType?: string },
  deps: ConnectedFirstDeps = REAL_CONNECTED,
  direct = hostedIdentifyWhy,
): ReturnType<typeof hostedIdentifyWhy> {
  const out = await identifyWhyForUncounted(opts, deps, direct);
  const kind = (out.answer as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string") noteIdentification(opts.orgId, "vision", kind !== "unidentifiable");
  return out;
}

async function identifyWhyForUncounted(
  opts: Parameters<typeof hostedIdentifyWhy>[0] & { mimeType?: string },
  deps: ConnectedFirstDeps,
  direct: typeof hostedIdentifyWhy,
): ReturnType<typeof hostedIdentifyWhy> {
  const asked = await askConnectedFirst(
    opts.orgId,
    "identify.image",
    opts.barcode ? { barcode: opts.barcode } : {},
    deps,
    async () => {
      const id = await deps.writeFile(opts.orgId, Buffer.from(opts.imageB64, "base64"), opts.mimeType ?? "image/jpeg");
      return id ? { image: id } : null;
    },
  );
  if (!asked) return direct(opts);
  const o = (asked.output ?? {}) as { kind?: unknown };
  if (o.kind !== "item" && o.kind !== "receipt" && o.kind !== "person" && o.kind !== "unidentifiable") return direct(opts);
  return { answer: { ...(asked.output as object), source: asked.label } as Awaited<ReturnType<typeof hostedIdentifyWhy>>["answer"] };
}
