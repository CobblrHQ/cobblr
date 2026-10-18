// platform:set-notification-default (#6909): the page's PUT and Cobb's door.
import type { ActionInvokeContext } from "@cobblr/platform-contract";
import { platform } from "@cobblr/platform-contract";
import { registerHandler } from "./actions.js";
import { DEFAULT_CHANNELS, DEFAULT_CHANNEL_WORDS, DEFAULTABLE_PRIORITIES, setWorkspaceDefault, type DefaultChannel, type DefaultablePriority } from "./notification-defaults.js";

export interface SetDefaultOutcome {
  ok: boolean;
  error?: string;
  summary?: string;
  data?: { priority: DefaultablePriority; channel: DefaultChannel | null; was: DefaultChannel | null };
}

/** Set one priority's default from loose input (a route body or an action's
 *  args). The caller has already checked the person may. */
export async function applyNotificationDefault(orgId: string, userId: string | null, priority: unknown, channel: unknown): Promise<SetDefaultOutcome> {
  if (!DEFAULTABLE_PRIORITIES.includes(priority as DefaultablePriority)) return { ok: false, error: "Choose urgent or high events." };
  const ch = channel === "none" || channel === null || channel === "" ? null : channel;
  if (ch !== null && !DEFAULT_CHANNELS.includes(ch as DefaultChannel)) return { ok: false, error: "Choose email, Discord, phone and computer notifications, or the bell alone." };
  const was = await setWorkspaceDefault(orgId, priority as DefaultablePriority, ch as DefaultChannel | null, userId);
  const how = ch ? DEFAULT_CHANNEL_WORDS[ch as DefaultChannel].split(" (")[0] : "the bell alone";
  return {
    ok: true,
    summary: `Members who have not chosen for themselves now hear ${priority} events by ${how}.`,
    data: { priority: priority as DefaultablePriority, channel: ch as DefaultChannel | null, was },
  };
}

export function registerNotificationDefaultAction(): void {
  // The kernel registry itself: platform() is not set yet while handlers register at load.
  registerHandler("platform.set-notification-default", async (ctx: ActionInvokeContext) => {
    if (!ctx.userId || !(await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" }))) return { ok: false, error: "Only a workspace owner or admin can do that." };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    return applyNotificationDefault(ctx.orgId, ctx.userId, args.priority, args.channel);
  });
}
