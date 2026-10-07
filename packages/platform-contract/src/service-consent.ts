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
  const effect: ServiceEffect = (["none", "signal", "stops", "writes", "spends", "physical"] as const).includes(effectIn as ServiceEffect)
    ? (effectIn as ServiceEffect)
    : "physical";
  const policy = ctx.policy ?? "default";
  if (policy === "off") return { verdict: "refuse", reason: "This is turned off for this workspace." };
  if (effect === "signal") return { verdict: "run" };
  // Bringing a machine toward stopped is never held, not even with Changes
  // off: it is the one thing that must not wait (#5091).
  if (effect === "stops") return { verdict: "run" };

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

// Where the Cobb and MCP doors read a person's Changes setting. It lives in
// core-ai's own table, which the kernel may not read (module isolation), so
// core-ai registers how to read it and the gate asks through here. No source
// registered, or one that fails, reads as "ask": the careful setting.
type WriteModeSource = (orgId: string, userId: string) => Promise<ServiceWriteMode | null>;
let writeModeSource: WriteModeSource | null = null;

export function registerServiceWriteModeSource(fn: WriteModeSource): void {
  writeModeSource = fn;
}

export async function serviceWriteModeFor(orgId: string, userId: string | null): Promise<ServiceWriteMode> {
  if (!userId || !writeModeSource) return "ask";
  try {
    return (await writeModeSource(orgId, userId)) ?? "ask";
  } catch {
    return "ask";
  }
}

/** Whether a job of this effect waits for a person even when Cobb starts it
 *  with Changes on Auto: what a tool list or a prompt tells the model, so it
 *  says "waiting" rather than "done". Read from the rule, never beside it. */
export function serviceWaitsForAPerson(effect: ServiceEffect | string): boolean {
  return serviceConsent(effect, "cobb", { writeMode: "auto" }).verdict !== "run";
}

// What a yes given ahead of its moment can wait for (services.md section 9:
// "power off after this print"). The owner of a kind of thing registers it:
// the event that says the thing is finished, the payload field that names
// it, and how to tell whether an id is one of its own (with a label a person
// reads on the card: "when the print Bracket v2 finishes"). The kernel
// registers "a service job is done"; digifab registers "a print finished".
export interface ServiceConfirmTrigger {
  event: string;
  /** The payload field that names the thing, e.g. "jobId". */
  key: string;
  /** This trigger's label for `id` in this workspace, or null when `id` is
   *  not one of its things. */
  describe: (orgId: string, id: string) => Promise<string | null>;
}
const confirmTriggers: ServiceConfirmTrigger[] = [];
const onTrigger: Array<(t: ServiceConfirmTrigger) => void> = [];

export function registerServiceConfirmTrigger(t: ServiceConfirmTrigger): void {
  if (confirmTriggers.some((x) => x.event === t.event)) return;
  confirmTriggers.push(t);
  for (const fn of onTrigger) fn(t);
}

export function serviceConfirmTriggers(): readonly ServiceConfirmTrigger[] {
  return confirmTriggers;
}

/** Be told of every trigger, those registered already and those to come. */
export function onServiceConfirmTrigger(fn: (t: ServiceConfirmTrigger) => void): void {
  onTrigger.push(fn);
  for (const t of confirmTriggers) fn(t);
}
