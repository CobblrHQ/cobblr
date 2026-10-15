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

/** What makes it a person's own step, where they do it, and the
 *  take_user_to destination that opens that screen filled in, when there is
 *  one. A refusal that promised a screen the assistant cannot open sent it
 *  to promise one too (the assistant audit, #6686). */
export interface HumanOnly {
  does: string;
  where: string;
  escort?: string;
}

/** Action id → what it does that makes it a person's own step, and where. */
export const HUMAN_ONLY_ACTIONS: Readonly<Record<string, HumanOnly>> = {
  "platform:invite-person": { does: "grants someone access to this workspace", where: "Configuration → People, Invite", escort: "members" },
  "platform:hand-off-things": { does: "hands everything one person owns to another", where: "Configuration → People, Hand off" },
  "platform:approve-request": { does: "decides what a person may do", where: "the request's card" },
  "platform:deny-request": { does: "decides what a person may do", where: "the request's card" },
  "platform:sign-in-phone-for": { does: "signs a phone in as someone else", where: "Configuration → Permissions, Accounts: Sign in their phone" },
};

/** Why `actionId` with these `args` is a person's own step, or null. Some
 *  actions are human-only in one branch: sharing with someone already shared
 *  with is an assistant's to do; sharing with a new email address brings a new
 *  person into a shared workspace and is not. */
export function humanOnly(actionId: string, args?: Record<string, unknown> | null): HumanOnly | null {
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
  if (!h) return null;
  const help = h.escort
    ? `Offer to open it for them, filled in (take_user_to, destination ${h.escort}); never run it.`
    : "Tell them where it is; there is no screen you can open for it, so do not offer one. Never run it.";
  return `That ${h.does}, so a person does it themselves: ${h.where}. ${help}`;
}
