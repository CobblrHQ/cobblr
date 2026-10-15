// Workspace GET routes that WAIT instead of answering, which every discovered-route sweep leaves out.
//
// The sweeps read every GET the api serves (meta checkouts per list, secrets, capability-scoped fields).
// These three hold the request until something outside the test happens, then answer nothing a sweep
// can judge: a long-poll answers 204 until a bridge's work arrives, and a discovery asks the network
// through a bridge and answers the devices it found. Each read cost the sweep its whole timeout (20 to
// 25 s), about 130 test-seconds a full run across four files (#6568, 2026-10-15). Curated, each with
// why; a sweep checks every entry still names a route the api serves.
export const WAITING_READS: Record<string, string> = {
  "/edge/poll": "a bridge's long-poll: answers 204 until relayed work arrives, never a read of records",
  "/modules/digifab/bench/discover": "asks the network through a bridge for ESPHome benches and waits the relay timeout",
  "/modules/digifab/snapmaker/discover": "asks the network through a bridge for Snapmakers and waits the relay timeout",
};

/** The route under the workspace, from any of the sweeps' spellings: "GET /api/v1/orgs/:slug/edge/poll",
 *  "/:slug/edge/poll" or "/edge/poll". */
export const workspaceRoute = (route: string): string => route.replace(/^GET /, "").replace(/^\/api\/v1\/orgs/, "").replace(/^\/:slug(?=\/)/, "");

/** Whether a sweep should leave this route out: it waits instead of answering. */
export const waitsInsteadOfAnswering = (route: string): boolean => workspaceRoute(route) in WAITING_READS;
