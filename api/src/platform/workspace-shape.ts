// The workspace's SHAPE version: which modules are on, which collections it
// has, which bundles are installed. An open app keeps all of that in its query
// cache (the menu, the filing destinations, the counts beside them), and none
// of it changes on its own, so after something changes it the app has to be
// TOLD. It was not: a receipt filing that installed two apps left the phone's
// menu without them until a reload (#3582).
//
// Told here, once, for every door: each write that changes the shape calls
// bumpWorkspaceShape, and every workspace response carries the newest version
// in X-Cobblr-Workspace-Shape (middleware/tenant.ts). The web's one request
// function watches that header and refreshes the workspace's queries when it
// moves. A response header rather than a field, because the install that
// matters most runs in a NESTED request (filing calls materialize over HTTP):
// its own response goes to the filing handler, never to the browser, but the
// filing's response is written after it and carries the bump.
//
// The in-process map is what makes that last part true without a second read
// of the org row at the end of every request; the column is the truth across
// processes and restarts. `lint:shape-writes-bump` holds every writer to it.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

export const WORKSPACE_SHAPE_HEADER = "X-Cobblr-Workspace-Shape";

const latest = new Map<string, number>();

/** Record that this workspace's shape changed. Never throws: a counter that
 *  could not move costs a stale menu until the next reload, which is what
 *  happened before it existed, and must not fail the install that called it. */
export async function bumpWorkspaceShape(orgId: string): Promise<void> {
  try {
    const row = await meta
      .updateTable("orgs")
      .set({ shape_version: sql<number>`shape_version + 1` })
      .where("id", "=", orgId)
      .returning("shape_version")
      .executeTakeFirst();
    if (row) latest.set(orgId, Math.max(row.shape_version, latest.get(orgId) ?? 0));
  } catch (err) {
    console.error(`[workspace-shape] org ${orgId}: could not bump:`, (err as Error).message);
  }
}

/** The version to serve: the newer of what the request read at its start and
 *  what this process has bumped to since. */
export function servedShapeVersion(orgId: string, readAtStart: number): number {
  return Math.max(readAtStart, latest.get(orgId) ?? 0);
}
