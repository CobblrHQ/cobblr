// The gate every service job passes before it exists (services.md sections 9
// and 10): who has to say yes, what that yes is bound to, and how far a chain
// of jobs may go. The kernel's invoke calls it with the door it stamped and
// stores what it returns; nothing else decides whether a job may start.

import { createHash } from "node:crypto";
import { confirmMaterial, nextHop, serviceConsent, serviceWriteModeFor, type ServicePolicy, type ServiceWriteMode } from "@cobblr/platform-contract/service-consent";
import type { ServiceDoor, ServiceEffect } from "@cobblr/platform-contract/services";
import { meta } from "../db/meta.js";

export interface GateRequest {
  orgId: string;
  door: ServiceDoor;
  /** The person the door acts for, when there is one. */
  userId?: string | null;
  capability: string;
  /** The capability's effect as its manifest declares it. */
  effect: ServiceEffect | string;
  input: unknown;
  /** The input files by name, as their sha256. */
  fileHashes: Record<string, string>;
  connectionId: string | null;
  /** The hop of the job whose result led here; absent for a job nothing caused. */
  causeHop?: number | null;
  /** The chat's Changes setting, for the Cobb and MCP doors. Read from the
   *  person's own setting when the door did not say. */
  writeMode?: ServiceWriteMode;
  /** A wire whose author allowed its writes to run. */
  wireRuns?: boolean;
}

export interface GateResult {
  status: "queued" | "awaiting_confirm";
  /** sha256 of what a confirm is bound to; stored either way, so a job's
   *  request can be told apart from an edited copy of it. */
  confirm_hash: string;
  hop: number;
}

/** Why a job was not created, as the sentence the caller shows. */
export class ServiceRefused extends Error {
  constructor(
    readonly code: "refused" | "hop_limit" | "not_found" | "not_waiting" | "expired" | "not_yours" | "changed",
    message: string,
  ) {
    super(message);
    this.name = "ServiceRefused";
  }
}

export function confirmHashOf(req: Pick<GateRequest, "capability" | "input" | "fileHashes" | "connectionId">): string {
  return createHash("sha256").update(confirmMaterial(req)).digest("hex");
}

/** A workspace's policy for a capability; "default" when it has none. */
export async function policyFor(orgId: string, capability: string): Promise<ServicePolicy> {
  const row = await meta
    .selectFrom("service_capability_policies")
    .select("policy")
    .where("org_id", "=", orgId)
    .where("capability", "=", capability)
    .executeTakeFirst();
  return row?.policy ?? "default";
}

export async function gateServiceJob(req: GateRequest): Promise<GateResult> {
  const hop = nextHop(req.causeHop);
  if (hop === null) {
    throw new ServiceRefused("hop_limit", "This was started by a chain of jobs that has gone as far as it may. Start it again by hand if it is wanted.");
  }
  const policy = await policyFor(req.orgId, req.capability);
  const writeMode =
    req.writeMode ?? (req.door === "cobb" || req.door === "mcp" ? await serviceWriteModeFor(req.orgId, req.userId ?? null) : undefined);
  const consent = serviceConsent(req.effect, req.door, { writeMode, policy, wireRuns: req.wireRuns });
  if (consent.verdict === "refuse") throw new ServiceRefused("refused", consent.reason);
  return {
    status: consent.verdict === "run" ? "queued" : "awaiting_confirm",
    confirm_hash: confirmHashOf(req),
    hop,
  };
}
