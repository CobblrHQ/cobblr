// The safe-run rules for a robot arm, as pure decisions (spec #6883 §0a).
// The store applies them; each has a test named after the consequence it
// prevents. None of them ever decides to command the arm: they decide what
// Cobblr records and what it refuses.
import type { ArmEvent, ArmRunOutcome, ArmState } from "@cobblr/platform-contract/robot-arm";

export const APPROVAL_MINUTES = 30;
export const OWNERSHIP_MINUTES = 5;

export interface Approval { revision: string | null; tooling: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }
export interface ProgramNow { revision: string | null; missing_since: Date | null; released_at: Date | null }

/** (1) An approval starts one run of exactly what the person checked at the
 *  cell: this arm, this program revision, this tooling. Anything changed,
 *  expired, used or revoked needs a new approval. */
export function approvalRefusal(a: Approval, program: ProgramNow | null, tooling: string, now: Date): string | null {
 if (a.revoked_at) return "This approval was revoked. Approve again at the cell.";
 if (a.used_at) return "This approval already started a run. A new run needs a new approval at the cell.";
 if (a.expires_at <= now) return "This approval expired. Check the cell and approve again.";
 if (!program || program.missing_since) return "The approved program is no longer on the controller. Read its programs and approve again.";
 if (program.revision !== a.revision) return "The program changed since it was approved. Approve the new revision at the cell.";
 if (!program.released_at) return "This revision is not released for production. Review what changed in it and release it first.";
 if (tooling !== a.tooling) return "The arm's tooling changed since it was approved. Approve again with the tooling installed now.";
 return null;
}

export interface Ownership { station_id: string; expires_at: Date; released_at: Date | null }

/** (2) One controller of the arm at a time. A station holds control until it
 *  expires or is released, and the pendant (local mode) always wins. */
export function ownershipRefusal(own: Ownership | null, stationId: string, state: ArmState | null, now: Date): string | null {
 if (state && state.mode === "local") return "The pendant has control of the arm. Cobblr gives way until it is back in remote mode.";
 if (!own || own.released_at) return "Take control of the arm at this station first.";
 if (own.expires_at <= now) return "This station's control of the arm expired. Take control again.";
 if (own.station_id !== stationId) return "Another station has control of this arm.";
 return null;
}

/** Whether a station may take control now. */
export function takeControlRefusal(own: Ownership | null, stationId: string, state: ArmState | null, now: Date): string | null {
 if (!state || state.connectivity !== "online") return "The arm's controller is not answering. Take control when it answers.";
 if (state.mode !== "remote") return "The pendant has control of the arm. Switch it to remote mode at the pendant first.";
 if (own && !own.released_at && own.expires_at > now && own.station_id !== stationId) return "Another station has control of this arm until it releases it or its control expires.";
 return null;
}

export interface OpenRun { status: "starting" | "uncertain" | "running"; program: { name: string; revision: string | null } | null; controller_run_id: string | null }

/** A run still "starting" this long after it was recorded was left there by a
 *  start that never saved its answer: it is read like a lost answer. */
export const STARTING_MINUTES = 5;
export function strandedStart(run: { status: string; started_at: Date }, now: Date): boolean {
 return run.status === "starting" && now.getTime() - new Date(run.started_at).getTime() >= STARTING_MINUTES * 60_000;
}

/** (3) A start whose answer was lost is reconciled by reading the arm, never
 *  by sending Start again. Returns what the run becomes, or null to keep
 *  waiting (no reading yet). */
export function reconcileStart(run: OpenRun, state: ArmState | null): { status: "running"; controller_run_id: string | null } | { status: "ended"; outcome: "not-started"; why: string } | null {
 if (run.status !== "uncertain") return null;
 if (!state || state.connectivity !== "online") return null;
 const same = !!state.program && !!run.program && state.program.name === run.program.name && state.program.revision === run.program.revision;
 if ((state.execution === "running" || state.execution === "paused") && (state.run_id ? !run.controller_run_id || run.controller_run_id === state.run_id : same)) return { status: "running", controller_run_id: state.run_id ?? run.controller_run_id };
 return { status: "ended", outcome: "not-started", why: `The controller reports ${state.execution} and no run of this program. Start was not sent again.` };
}

export type EventEffect =
 | { kind: "adopt"; controller_run_id: string }
 | { kind: "cycle"; cycle: number; good: number; scrap: number }
 | { kind: "end"; outcome: "completed" | "aborted"; detail: string | null }
 | { kind: "release-control" }
 | { kind: "none" };

/** (4)(5)(6) What one NEW event does to the records. A replayed event is
 *  never applied twice (the store records each event id once, and a cycle
 *  count only rises), and no effect is ever a command to the arm. A run
 *  completes only on its own run-ended event; the controller reading
 *  stopped or idle completes nothing. */
export function eventEffect(ev: ArmEvent, run: OpenRun | null): EventEffect {
 if (ev.type === "mode-changed") return ev.mode === "local" ? { kind: "release-control" } : { kind: "none" };
 if (!run) return { kind: "none" };
 if (ev.type === "run-started") {
  const same = !!run.program && ev.program.name === run.program.name && ev.program.revision === run.program.revision;
  return (!run.controller_run_id && same) || run.controller_run_id === ev.run_id ? { kind: "adopt", controller_run_id: ev.run_id } : { kind: "none" };
 }
 if (ev.type === "cycle-completed") return run.controller_run_id === ev.run_id ? { kind: "cycle", cycle: ev.cycle, good: ev.good, scrap: ev.scrap } : { kind: "none" };
 if (ev.type === "run-ended") return run.controller_run_id === ev.run_id ? { kind: "end", outcome: ev.outcome, detail: ev.detail } : { kind: "none" };
 return { kind: "none" };
}

/** A person may say a run's outcome only when the arm cannot: unknown at any
 *  time, aborted only when the controller reports it is not running.
 *  Completed always needs the controller's evidence. */
export function personOutcomeRefusal(outcome: ArmRunOutcome, state: ArmState | null): string | null {
 if (outcome === "unknown") return null;
 if (outcome !== "aborted") return "A run completes only on the arm's own report that it finished. Say unknown if you cannot tell.";
 if (!state || state.connectivity !== "online") return "The controller is not answering, so Cobblr cannot tell the run stopped. Say unknown.";
 if (state.execution === "running" || state.execution === "paused") return "The arm still reports this program running. Stop it first, or say unknown.";
 return null;
}

/** (7) Losing the cloud and losing the controller are different failures:
 *  without the bridge Cobblr knows nothing about the arm, and the arm may
 *  well be running; with the bridge and no controller, the bridge knows the
 *  controller is silent. Neither ends a run or is a reason to start one. */
export function linkLost(bridgeAnswered: boolean, state: ArmState | null): "cloud" | "controller" | null {
 if (!bridgeAnswered) return "cloud";
 if (!state || state.connectivity !== "online") return "controller";
 return null;
}
export const LINK_WORDS = {
 cloud: "Cobblr cannot reach the shop's bridge. The arm may still be running; nothing is assumed until the bridge answers.",
 controller: "The bridge cannot reach the arm's controller. Check the arm at the cell; its run stays open until the arm reports.",
} as const;
