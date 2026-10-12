import { platform } from "@cobblr/platform-contract";

/** The entry every door that makes a part writes: the form, a family's new
 *  child, an app's create-item (the Cataloging Bench), a bulk create. A door
 *  that skipped it left the record's History empty (#5923). userId is who
 *  made it; null records it as the system's. */
export function logPartCreated(orgId: string, id: string, diff: Record<string, unknown>, userId: string | null): Promise<void> {
  return platform().activity.log({
    orgId,
    userId,
    action: "part_created",
    ref: { module: "inventory", entityType: "part", entityId: id },
    diff,
  });
}
