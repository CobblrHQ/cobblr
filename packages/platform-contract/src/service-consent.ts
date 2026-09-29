// Who has to say yes before a service does its work.
//
// A connected service declares what each capability does to the world
// (`effect`, docs/design-decisions/services.md section 9): nothing outside
// itself, writes somewhere the person owns, spends money, or moves or heats
// something physical. Five doors can start a job: a person's own request, Cobb
// in the in-app chat, an MCP client, a wire, and module code. One rule, here,
// that every door imports, so no door decides for itself. `physical` is never
// automatic from any of them: that is the owner's standing rule about the
// physical world, held here rather than in each dialog (`lint:service-consent`
// refuses a second place that decides on an effect).
//
// Buildless subpath: no runtime import of a sibling (a type import is
// erased, a value import is not, and at runtime it cannot resolve).

import type { ServiceDoor, ServiceEffect } from "./services.js";

/** The same limit as services.ts's MAX_SERVICE_HOPS, restated because this
 *  subpath may not import a sibling's value; a test pins the two equal. */
const MAX_SERVICE_HOPS = 8;

export type { ServiceDoor, ServiceEffect };

/** A workspace's per-capability setting. `run` relaxes `writes` only. */
export type ServicePolicy = "default" | "always_ask" | "run" | "off";

/** The chat's Changes setting, for the Cobb and MCP doors. */
export type ServiceWriteMode = "off" | "ask" | "auto";

export type ServiceConsent =
  /** Start it now. */
  | { verdict: "run" }
  /** Hold it as `awaiting_confirm` until a person who may run it says yes. */
  | { verdict: "confirm" }
  /** Do not create it; `reason` is the sentence the caller shows. */
  | { verdict: "refuse"; reason: string };

const NO_CONFIRM_HERE =
  "This connection has no way to show a confirmation, and this needs a person to say yes. Start it from Cobblr, where the confirm step appears.";

/**
 * The one rule. `writeMode` matters for the Cobb and MCP doors, `wireRuns`
 * for a wire whose author allowed its writes to run.
 */
export function serviceConsent(
  effectIn: ServiceEffect | string,
  door: ServiceDoor,
  ctx: { writeMode?: ServiceWriteMode; policy?: ServicePolicy; wireRuns?: boolean } = {},
): ServiceConsent {
  // An unknown effect reads as the strongest: a service cannot talk its way
  // out of a confirm by misspelling one.
  const effect: ServiceEffect = (["none", "writes", "spends", "physical"] as const).includes(effectIn as ServiceEffect)
    ? (effectIn as ServiceEffect)
    : "physical";
  const policy = ctx.policy ?? "default";
  if (policy === "off") return { verdict: "refuse", reason: "This is turned off for this workspace." };

  // A door that cannot show a card may only run what needs no card.
  const confirmOrRefuse = (): ServiceConsent => (door === "mcp" ? { verdict: "refuse", reason: NO_CONFIRM_HERE } : { verdict: "confirm" });

  if ((door === "cobb" || door === "mcp") && ctx.writeMode === "off" && effect !== "none") {
    return { verdict: "refuse", reason: 'Changes are turned off for this chat. The person can allow them in the chat\'s tool settings ("Changes" → Ask or Auto).' };
  }

  if (effect === "physical") return confirmOrRefuse();
  if (effect === "spends") return door === "person" && policy !== "always_ask" ? { verdict: "run" } : confirmOrRefuse();
  if (policy === "always_ask") return door === "person" ? { verdict: "confirm" } : confirmOrRefuse();
  if (effect === "none") return { verdict: "run" };

  // writes
  switch (door) {
    case "person":
    case "module":
      return { verdict: "run" };
    case "cobb":
      return ctx.writeMode === "auto" || policy === "run" ? { verdict: "run" } : { verdict: "confirm" };
    case "mcp":
      return ctx.writeMode === "auto" || policy === "run" ? { verdict: "run" } : { verdict: "refuse", reason: NO_CONFIRM_HERE };
    case "wire":
      return ctx.wireRuns || policy === "run" ? { verdict: "run" } : { verdict: "confirm" };
  }
}

/** Whether a job may start with no person confirming it. */
export function serviceRunsUnconfirmed(
  effect: ServiceEffect | string,
  door: ServiceDoor,
  ctx?: Parameters<typeof serviceConsent>[2],
): boolean {
  return serviceConsent(effect, door, ctx).verdict === "run";
}

/** The hop a job started by `causeHop`'s job carries, or null when the chain
 *  has gone as far as it may. A job nothing else caused is hop 0. */
export function nextHop(causeHop: number | null | undefined): number | null {
  const hop = causeHop == null ? 0 : causeHop + 1;
  return hop >= MAX_SERVICE_HOPS ? null : hop;
}

/** JSON with keys sorted at every level, so the same request always
 *  serialises the same way whatever order its keys were built in. What a
 *  confirm is bound to is hashed from this. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** What a confirm is bound to: the capability, the input, the input files by
 *  hash and the connection that will run it. Hash this string (sha256) and
 *  store it on the job; confirm recomputes it and refuses a mismatch. */
export function confirmMaterial(req: { capability: string; input: unknown; fileHashes: Record<string, string>; connectionId: string | null }): string {
  return canonicalJson({ v: 1, capability: req.capability, input: req.input ?? null, files: req.fileHashes, connection: req.connectionId });
}
