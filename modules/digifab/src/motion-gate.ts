// Who may make a machine move (#6785). Stopping is every member's, at every door (#5091); anything else a
// control does, resuming, framing, homing, jogging, heating or starting a test, runs the machine, and that is
// the operator's (digifab:operate, #6761) or the admin tier's. The page's control routes and the control
// actions Cobb reaches all ask here, so a member is never refused a stop and never resumes a laser.
import { platform } from "@cobblr/platform-contract";

export const STOP_CONTROLS: ReadonlySet<string> = new Set(["stop", "pause", "abort", "output-off"]);

/** The capability a control past a stop needs. */
export const RUN_MACHINES = "digifab:operate";

/** What a member refused a control is told: what it needs, and what is still theirs. */
export const RUN_MACHINES_REFUSAL = "Starting, resuming or framing a machine needs permission to run machines, which an admin gives. Stopping and pausing are every member's.";

export function isStopControl(operation: string): boolean {
  return STOP_CONTROLS.has(operation);
}

/** May this person use `operation` on a machine? A stop needs a member; anything else needs digifab:operate. */
export async function mayControl(args: { orgId: string; userId: string | null | undefined; operation: string }): Promise<boolean> {
  if (!args.userId) return false;
  if (!(await platform().auth.userHasRole({ orgId: args.orgId, userId: args.userId, minRole: "member" }))) return false;
  if (isStopControl(args.operation)) return true;
  return platform().auth.userMayRun({ orgId: args.orgId, userId: args.userId, actionId: RUN_MACHINES });
}
