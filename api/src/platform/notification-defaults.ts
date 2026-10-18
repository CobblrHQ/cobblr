// How a workspace's members hear its urgent and high events until they choose
// for themselves (#6909). The WHO half is audiences (notification-audience.ts);
// this is the HOW half. Resolution, in dispatch: the member's own choice in
// this workspace, else this default, else the bell alone. A member who has set
// any channel in this workspace has chosen, so the default never reaches them
// and never turns back on a channel they turned off.
import { meta } from "../db/meta.js";

export const DEFAULTABLE_PRIORITIES = ["urgent", "high"] as const;
export type DefaultablePriority = (typeof DEFAULTABLE_PRIORITIES)[number];
export const DEFAULT_CHANNELS = ["email", "discord_dm", "browser_push"] as const;
export type DefaultChannel = (typeof DEFAULT_CHANNELS)[number];

/** In words, for the screen and Cobb. */
export const DEFAULT_CHANNEL_WORDS: Record<DefaultChannel, string> = {
  email: "Email",
  discord_dm: "Discord (for members who connected it)",
  browser_push: "Phone and computer notifications (on devices members turned them on)",
};

export type WorkspaceDefaults = Record<DefaultablePriority, DefaultChannel | null>;

export async function workspaceDefaults(orgId: string): Promise<WorkspaceDefaults> {
  const rows = await meta.selectFrom("workspace_notification_defaults").select(["priority", "channel"]).where("org_id", "=", orgId).execute();
  const out: WorkspaceDefaults = { urgent: null, high: null };
  for (const r of rows) out[r.priority] = r.channel;
  return out;
}

/** Set, or with `null` clear, one priority's default. Returns what it was, for
 *  an undo. */
export async function setWorkspaceDefault(orgId: string, priority: DefaultablePriority, channel: DefaultChannel | null, by: string | null): Promise<DefaultChannel | null> {
  const before = (await workspaceDefaults(orgId))[priority];
  if (channel === null) {
    await meta.deleteFrom("workspace_notification_defaults").where("org_id", "=", orgId).where("priority", "=", priority).execute();
  } else {
    await meta
      .insertInto("workspace_notification_defaults")
      .values({ org_id: orgId, priority, channel, updated_by: by })
      .onConflict((oc) => oc.columns(["org_id", "priority"]).doUpdateSet({ channel, updated_by: by, updated_at: new Date() }))
      .execute();
  }
  return before;
}

/** The workspace's default channel for an event of `priority`, for a member who
 *  has chosen nothing here; null when it has none. PURE over the defaults. */
export function defaultFor(defaults: WorkspaceDefaults, priority: string): DefaultChannel | null {
  return priority === "urgent" ? defaults.urgent : priority === "high" ? defaults.high : null;
}
