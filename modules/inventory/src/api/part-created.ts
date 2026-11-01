import { platform, type ActivityLogParams } from "@cobblr/platform-contract";

/** The entry every door that makes a part writes: the form, a family's new
 *  child, an app's create-item (the Cataloging Bench), a bulk create. A door
 *  that skipped it left the record's History empty (#5923). userId is who
 *  made it; null records it as the system's. */
export function logPartCreated(orgId: string, id: string, diff: Record<string, unknown>, userId: string | null, log?: (p: ActivityLogParams) => Promise<void>): Promise<void> {
  const params: ActivityLogParams = {
    orgId,
    userId,
    action: "part_created",
    ref: { module: "inventory", entityType: "part", entityId: id },
    diff,
  };
  // capability-except activity:a-change-and-its-history-line-commit-together: the family child route calls this after addChild, which owns its insert and placement; the create routes pass their transaction logger (#9035)
  return log ? log(params) : platform().activity.log(params);
}
