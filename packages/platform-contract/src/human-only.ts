// What only a person does, never an assistant (the owner, 2026-10-14: the
// AI-reach rule holds "with limitations concerning things like account
// security and certain specific things that only a human can do").
//
// Granting someone access to a workspace, deciding what a person may do,
// handing one person's things to another, bringing a new person into a share:
// each is a person's own step on a screen. An assistant may explain it or open
// that screen, filled in, and the person presses the button. Never a tool.
//
// One list, asked by every door an assistant uses: the invoke route (MCP, the
// relay, the in-app chat's own calls), list_actions and the chat's write check
// (before any confirm card exists, so there is nothing for a person to press
// on the assistant's say-so). Pinned by human-only.test.ts; an id here is never
// declared as an action an assistant is offered.

/** Action id → what it does that makes it a person's own step, and where. */
export const HUMAN_ONLY_ACTIONS: Readonly<Record<string, { does: string; where: string }>> = {
  "platform:invite-person": { does: "grants someone access to this workspace", where: "Configuration → People, Invite" },
  "platform:hand-off-things": { does: "hands everything one person owns to another", where: "Configuration → People, Hand off" },
  "platform:approve-request": { does: "decides what a person may do", where: "the request's card" },
  "platform:deny-request": { does: "decides what a person may do", where: "the request's card" },
};

/** Why `actionId` with these `args` is a person's own step, or null. Some
 *  actions are human-only in one branch: sharing with someone already shared
 *  with is an assistant's to do; sharing with a new email address brings a new
 *  person into a shared workspace and is not. */
export function humanOnly(actionId: string, args?: Record<string, unknown> | null): { does: string; where: string } | null {
  const fixed = HUMAN_ONLY_ACTIONS[actionId];
  if (fixed) return fixed;
  if (actionId === "platform:share-with" && typeof args?.with === "string" && args.with.includes("@")) {
    return { does: "brings a new person into a shared workspace", where: "Share with… on the record or list" };
  }
  return null;
}

/** The sentence an assistant hears when it asks for one: what it is, and
 *  that the person does it, so the answer offers the screen instead. */
export function humanOnlyRefusal(actionId: string, args?: Record<string, unknown> | null): string | null {
  const h = humanOnly(actionId, args);
  return h
    ? `That ${h.does}, so a person does it themselves: ${h.where}. Offer to open that screen for them (take_user_to), filled in; never run it.`
    : null;
}
