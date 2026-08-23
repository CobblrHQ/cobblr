// Answering from inside a Discord DM, without a gateway.
//
// THE PROBLEM THIS SOLVES. Free-text DMs arrive only over the gateway
// (message-content intent), and a gateway and an Interactions Endpoint URL are
// MUTUALLY EXCLUSIVE — Discord: "you can only receive Interactions one of the
// two ways". So being able to type a reply into a DM has always meant standing
// up a gateway process and flipping the app's mode, plus solving the binding
// problem, because free text carries no workspace
// (docs/design-decisions/discord-workspace-app.md).
//
// A MODAL SIDESTEPS ALL OF IT, because a modal is an INTERACTION, not a
// message:
//
//   card with [Reply]  ──press──►  MESSAGE_COMPONENT (3)
//                      ◄─respond─  MODAL (9)          ← a text box appears
//   the person types   ──submit─►  MODAL_SUBMIT (5)   ← same HTTP endpoint
//
// Nothing on that path touches the gateway, and the workspace is never in
// doubt: the modal was opened from OUR card, whose custom_id names the
// notification, from which the org, the subject and the action are read back.
// The binding problem does not arise because there is nothing to bind.
//
// WHAT IT DOES NOT SOLVE: starting a conversation. "What's low on stock?" typed
// cold into the DM has no interaction to hang a modal off, and that still needs
// the gateway. Replying is the case worth having; initiating is rarer and can
// wait for someone to actually want it.
//
// Verified against the API docs 2026-08-24: MODAL_SUBMIT is type 5, MODAL is
// callback 9, and a modal is a legal response to a component interaction
// ("Not available for MODAL_SUBMIT and PING interactions" — so available for
// everything else). A modal may NOT answer a modal, which is why submitting
// returns a plain message.
//
// Pure on purpose, like discord-interaction.ts beside it: importing the route
// pulls the database and therefore env validation, which exits the process, so
// the payload shape would otherwise be untestable.

/** The interaction type a submitted modal arrives as. */
export const MODAL_SUBMIT = 5;
/** The callback type that opens one. */
export const MODAL_RESPONSE = 9;

/** Discord's cap on a text input value. */
export const REPLY_MAX = 4000;
/** Our own floor for the field, so the modal cannot post an empty comment. */
export const REPLY_MIN = 1;

/** The action id that means "let them write something back".
 *
 *  A reserved id rather than a per-module convention: the interactions handler
 *  has to recognise it BEFORE it resolves the action, because this press opens
 *  a box instead of doing anything. */
export const REPLY_ACTION_ID = "reply";

/** `cbl:<notificationId>:<actionId>` is the existing scheme and this reuses it
 *  verbatim, so a modal submit parses with the very same parsePress and cannot
 *  drift from the button path. */
export function modalCustomId(notificationId: string): string {
  return `cbl:${notificationId}:${REPLY_ACTION_ID}`;
}

/** The field inside the modal. One input, one id, no ambiguity when reading it
 *  back. */
export const REPLY_FIELD = "body";

/**
 * The modal to open when someone presses Reply.
 *
 * NOTE THE `Label` WRAPPER. Text inputs used to sit directly in an Action Row,
 * and that shape is now deprecated: "Label is recommended for use over an
 * Action Row in modals... all Text Inputs should be placed inside a Label
 * component", and Text Input's own `label` is deprecated in favour of the
 * Label's. Most examples in the wild still show the old form, which is exactly
 * why this is written down here rather than copied from one.
 */
export function replyModal(args: {
  notificationId: string;
  /** What they are replying TO, for the modal's title. */
  subject: string;
}): { type: number; data: Record<string, unknown> } {
  return {
    type: MODAL_RESPONSE,
    data: {
      custom_id: modalCustomId(args.notificationId),
      // Discord truncates a long title without saying so; do it deliberately.
      title: `Reply · ${args.subject}`.slice(0, 45),
      components: [
        {
          type: 18, // Label
          label: "Your reply",
          description: "Everyone in the workspace can read this.",
          component: {
            type: 4, // Text Input
            custom_id: REPLY_FIELD,
            style: 2, // paragraph
            min_length: REPLY_MIN,
            max_length: REPLY_MAX,
            required: true,
            placeholder: "Say something…",
          },
        },
      ],
    },
  };
}

/**
 * Read the typed text out of a MODAL_SUBMIT payload.
 *
 * Walks the tree rather than indexing a fixed path, because the nesting is
 * exactly the thing that changed under us once already (Action Row → Label). A
 * reader that hunts for its own custom_id survives the next reshuffle; one that
 * reads `components[0].components[0].value` does not.
 */
export function readReply(data: unknown): string | null {
  const found = findValue(data, REPLY_FIELD);
  if (typeof found !== "string") return null;
  const text = found.trim();
  return text.length ? text.slice(0, REPLY_MAX) : null;
}

function findValue(node: unknown, wantId: string): unknown {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findValue(child, wantId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.custom_id === wantId && "value" in o) return o.value;
    for (const v of Object.values(o)) {
      const hit = findValue(v, wantId);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
