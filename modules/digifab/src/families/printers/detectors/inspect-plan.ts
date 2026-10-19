// How the failure watch takes a reading through `inspect.print` (services.md
// §12): which checks, in what order, and what "no reading" means.
//
// The workspace's failure setting keeps its meaning:
//   auto  a connected inspection service first (when the workspace put one
//         first in its order), then the bridge's model, then the workspace's
//         AI, each asked only when the one before had no reading;
//   edge  the bridge's model only; no reading is no reading;
//   llm   the workspace's AI only.
// An external detector (backend "detector") keeps its own path in
// failure-detect.ts.
//
// Every reading is a new question (a fresh idempotency key per ask), so the
// watch never gets the last frame's job back.

import { randomUUID } from "node:crypto";
import type { DetectResult, FailureBackend } from "../failure-detect.js";

export const EDGE_BUILT_IN = "digifab.inspect-edge";
export const AI_BUILT_IN = "digifab.inspect-ai";

export interface InspectStep {
  via: { builtIn: string } | { credentialId: string };
  source: DetectResult["source"];
}

/** The steps a reading tries, in order. `first` is the workspace order's
 *  first answer for inspect.print. */
export function inspectPlan(backend: Exclude<FailureBackend, "detector">, first: { source: string; credential_id?: string } | null): InspectStep[] {
  const edge: InspectStep = { via: { builtIn: EDGE_BUILT_IN }, source: "edge" };
  const ai: InspectStep = { via: { builtIn: AI_BUILT_IN }, source: "llm" };
  if (backend === "edge") return [edge];
  if (backend === "llm") return [ai];
  const connected: InspectStep[] = first?.source === "connection" && first.credential_id ? [{ via: { credentialId: first.credential_id }, source: "detector" }] : [];
  return [...connected, edge, ai];
}

export interface InspectDeps {
  invoke(req: { orgId: string; capability: "inspect.print"; input: { connection_id: string; device_id: string }; via: InspectStep["via"]; idempotencyKey: string }): Promise<{ id: string; status: string }>;
  output(orgId: string, jobId: string): Promise<unknown>;
}

/** The first reading the plan gets. A step that fails, is still working, or
 *  has no reading hands on to the next; none left is no reading (null), which
 *  the watch already treats as "nothing to act on". */
export async function readThrough(orgId: string, connId: string, deviceId: string, plan: InspectStep[], deps: InspectDeps): Promise<DetectResult | null> {
  for (const step of plan) {
    try {
      const ref = await deps.invoke({
        orgId,
        capability: "inspect.print",
        input: { connection_id: connId, device_id: deviceId },
        via: step.via,
        idempotencyKey: randomUUID(),
      });
      if (ref.status !== "done") continue;
      const p = ((await deps.output(orgId, ref.id)) as { probability?: unknown } | null)?.probability;
      if (typeof p === "number" && Number.isFinite(p)) return { probability: Math.max(0, Math.min(1, p)), source: step.source };
    } catch {
      /* unreachable / refused / no such built-in: the next check, as before */
    }
  }
  return null;
}
