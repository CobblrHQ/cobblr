// POST /api/v1/discord/interactions — where a button press lands.
//
// TWO ways in, because there are two legitimate deployments:
//
//   FORWARDED   the Cobblr bot holds the gateway (it must: it also receives
//               DMs and handles the ops buttons), so Discord hands it the
//               press and it forwards here with the shared bot token. This is
//               the hosted shape.
//   DIRECT      a self-hosted instance with its own Discord app and no bot
//               process points the app's Interactions Endpoint URL straight
//               here. Ed25519-signed by Discord.
//
// The two are mutually exclusive AT DISCORD — an app cannot use a gateway and
// an endpoint at once — which is why both exist here rather than one.
//
// Whichever door it comes through, the press names a notification and an
// action id and nothing else. Everything real is read from the stored row.
//
// See docs/design-decisions/discord-workspace-app.md.

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { requireScope } from "../auth/capability.js";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import {
  assertActingRoleClearsActionFloor,
  ActionRoleFloorError,
} from "../platform/platform-actions.js";
import {
  MODAL_SUBMIT,
  readReply,
  replyModal,
  REPLY_ACTION_ID,
} from "../platform/discord-modal.js";
import {
  INTERACTION,
  RESPONSE,
  parsePress,
  pressMayAct,
  resolvePress,
  originalOf,
  settledMessage,
  verifySignature,
  type StoredNotification,
} from "../platform/discord-interaction.js";

export const discordInteractionsRouter = Router();

/** `||` not `??`: compose passes an unset var as "" (CLAUDE.md section 14.6). */
const publicKey = (): string => (process.env.COBBLR_DISCORD_PUBLIC_KEY || "").trim();

/** The DIRECT door: Discord posts here itself, for a deployment with its own
 *  app and no bot process. Unauthenticated by necessity — the Ed25519
 *  signature is the entire gate. */
discordInteractionsRouter.post("/discord/interactions", async (req, res) => {
  const key = publicKey();
  if (!key) {
    // Not configured. 404 rather than 500 or 401: an endpoint that says
    // "misconfigured" tells a prober it exists.
    res.status(404).end();
    return;
  }

  {
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    const ok =
      typeof raw === "string" &&
      verifySignature({
        publicKeyHex: key,
        signatureHex: String(req.header("X-Signature-Ed25519") ?? ""),
        timestamp: String(req.header("X-Signature-Timestamp") ?? ""),
        rawBody: raw,
      });
    // Discord REQUIRES a 401 on a bad signature — it probes with a deliberately
    // invalid one when you save the endpoint URL, and accepts the URL only if
    // that probe is rejected.
    if (!ok) {
      res.status(401).end();
      return;
    }
  }

  await handlePress(req, res);
});

/** The FORWARDED door: the Cobblr bot holds the gateway (it must — it also
 *  receives DMs and handles the ops buttons), so Discord hands it the press and
 *  it relays here.
 *
 *  Authenticated as an ordinary API token carrying `discord:interactions`,
 *  rather than a bespoke shared secret: the bot already holds a scoped Cobblr
 *  token, and the scope registry already enforces which paths a token may
 *  touch. The scope confers no authority of its own — the action still comes
 *  from the stored row and the presser must own it — so the worst a leaked
 *  token can do is replay a press its holder was already shown.
 *
 *  requireScope is NOT redundant with requireAuth's scope clamp. That clamp
 *  only bounds a SCOPED token; an unscoped token (`token_scopes === null`) and
 *  every browser session JWT skip it and are unrestricted. Since this handler
 *  reads the acting identity from the request BODY (member/user id → discord
 *  connection), not from the session, an unscoped caller reaching here could
 *  forge a press AS the victim the body names. requireScope refuses anything
 *  that was not deliberately minted with `discord:interactions`. */
discordInteractionsRouter.post(
  "/discord/interactions/forwarded",
  requireAuth,
  async (req, res) => {
    if (!requireScope(req, res, "discord:interactions")) return;
    await handlePress(req, res);
  },
);

async function handlePress(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    type?: number;
    data?: { custom_id?: string };
    member?: { user?: { id?: string } };
    user?: { id?: string };
    message?: { content?: string };
  };

  if (body.type === INTERACTION.PING) {
    res.json({ type: RESPONSE.PONG });
    return;
  }
  // A submitted modal is type 5, and it is the ONLY way free text reaches us
  // without a gateway process. Everything below treats it exactly like a press
  // — same custom_id, same parser, same ownership check — because it IS the
  // same press, just carrying what the person typed.
  const isModalSubmit = body.type === MODAL_SUBMIT;
  if (body.type !== INTERACTION.COMPONENT && !isModalSubmit) {
    res.status(204).end();
    return;
  }

  const original = originalOf(body.message);
  const ref = parsePress(String(body.data?.custom_id ?? ""));
  if (!ref) {
    // Someone else's component, or a probe. Say nothing useful.
    res.json(settledMessage(original, "This button is no longer valid."));
    return;
  }

  // In a DM there is no `member`; the presser is `user`.
  const discordUserId = body.member?.user?.id ?? body.user?.id ?? null;

  try {
    const [notification, conn] = await Promise.all([
      meta
        .selectFrom("notifications")
        .select(["id", "org_id", "user_id", "actions", "module_name", "entity_type", "entity_id"])
        .where("id", "=", ref.notificationId)
        .executeTakeFirst(),
      discordUserId
        ? meta
            .selectFrom("discord_connections")
            .innerJoin("users", "users.id", "discord_connections.user_id")
            // The display name rides along so the fan-out a press triggers can
            // say WHO replied. With `null` here, every reply posted from
            // Discord was attributed to "Somebody" in the notifications it
            // caused, while the same reply typed in the app carried the name.
            .select(["discord_connections.user_id as user_id", "users.display_name as display_name"])
            .where("discord_user_id", "=", discordUserId)
            .where("verified", "=", true)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);

    // The card runs a real write (a comment posts to the workspace), so the
    // presser must be a CURRENT member with enough role — not just the
    // recipient of the DM. Two holes this closes: a read-only guest, who is
    // legitimately mentioned and legitimately DM'd but may only READ in-app
    // (the in-app reply requires member+); and a member whose access was
    // revoked AFTER the DM was sent, since the notification row and the Discord
    // link both outlive the membership. The invoke() path is deliberately not
    // capability-gated (it is the wire/automation entry too), so the gate lives
    // here, mirroring the in-app twin's requireRole("owner","admin","member").
    const notifRow = notification as StoredNotification | undefined;
    const pressRole =
      conn?.user_id && notifRow
        ? (
            await meta
              .selectFrom("org_memberships")
              .select("role")
              .where("org_id", "=", notifRow.org_id)
              .where("user_id", "=", conn.user_id)
              .executeTakeFirst()
          )?.role
        : undefined;
    const mayAct = pressMayAct(pressRole);

    // A press of Reply does not DO anything: it opens a box. So it is answered
    // before the action is resolved, and the ownership check still has to pass
    // first — otherwise a forged id would open a modal naming somebody else's
    // record, which leaks the subject even if the submit later fails. The same
    // member gate applies: a guest/ex-member must not even open the reply box.
    if (!isModalSubmit && ref.actionId === REPLY_ACTION_ID) {
      const owns =
        notification && conn?.user_id && (notification as StoredNotification).user_id === conn.user_id;
      if (!owns || !mayAct) {
        res.json(settledMessage(original, "This button is no longer valid."));
        return;
      }
      res.json(
        replyModal({
          notificationId: ref.notificationId,
          // The card's own first line is the best short name for what this is
          // about, and it is already the text the person is looking at.
          subject: original.split("\n")[0]?.slice(0, 30) || "this",
        }),
      );
      return;
    }

    const resolved = resolvePress(
      (notification as StoredNotification | undefined) ?? null,
      conn?.user_id ?? null,
      ref,
    );
    if (!resolved.ok) {
      // Deliberately one message for every refusal. Distinguishing "not yours"
      // from "no such notification" tells a prober which ids exist.
      res.json(settledMessage(original, "This button is no longer valid."));
      return;
    }
    // Same member gate as the reply-modal branch, for a plain button press (and
    // the modal submit that follows an opened box). A guest or ex-member reaches
    // here owning the notification but must not perform the write.
    if (!mayAct) {
      res.json(settledMessage(original, "This button is no longer valid."));
      return;
    }

    // A modal carries what was typed; a button carries only its stored args.
    // Merging here rather than in resolvePress keeps that function pure and
    // keeps "what the user typed" out of anything a forged id could reach.
    const typed = isModalSubmit ? readReply(body.data) : null;
    if (isModalSubmit && !typed) {
      // Submitted empty. Discord already enforces min_length, so this is a
      // client that did not, and there is nothing to post.
      res.json(settledMessage(original, "Nothing to send."));
      return;
    }

    // The notification already records WHAT it is about, so an entity-scoped
    // action can be invoked from a card. Without this, `invoke` gets no entity
    // and requireActionEntity throws — every card action had to be
    // workspace-scoped, which quietly ruled out the interesting ones
    // (commenting on the record you were just told about).
    const row = notification as unknown as {
      module_name: string | null;
      entity_type: string | null;
      entity_id: string | null;
    };
    const entity =
      row.module_name && row.entity_type && row.entity_id
        ? { kind: `${row.module_name}:${row.entity_type}`, id: row.entity_id, fields: {} }
        : undefined;

    // Per-action role FLOOR, on top of the pressMayAct member gate above (audit
    // M-ACTION-PARITY). pressMayAct proves member+, but a floored action — an
    // owner-only platform:* one — must hold the SAME floor here that the HTTP
    // /actions/invoke route holds, because a card press reaches invoke()
    // directly. No such action is card-reachable today (they are workspace-
    // scoped, not notification actions), so this is defensive; the floor must
    // not depend on which door was used. Same neutral refusal as the other
    // gates so a prober learns nothing about roles or ids.
    try {
      assertActingRoleClearsActionFloor(resolved.action, pressRole);
    } catch (err) {
      if (err instanceof ActionRoleFloorError) {
        res.json(settledMessage(original, "This button is no longer valid."));
        return;
      }
      throw err;
    }

    await platform().actions.invoke(resolved.action, {
      orgId: resolved.orgId,
      userId: resolved.userId,
      ...(entity ? { scope: "entity" as const, entity } : {}),
      event: {
        name: "platform.notification.action",
        payload: { notificationId: ref.notificationId, actionId: ref.actionId },
        // "session" because a PERSON did this, having proved who they are —
        // the vocabulary has no term for "acting through a linked third-party
        // identity", and inventing one here would widen a platform enum every
        // activity-log reader depends on. The provenance is not lost: the
        // event payload names the notification and the action, so the trail
        // says Discord even though this field cannot.
        actor: { user_id: resolved.userId, display_name: conn?.display_name ?? null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args: typed ? { ...resolved.args, body: typed } : resolved.args,
    });

    res.json(
      settledMessage(
        original,
        isModalSubmit ? "✅ Sent." : `✅ ${resolved.label}`,
        // Only a reply has anything to echo; a plain action press does not.
        typed,
      ),
    );
  } catch (err) {
    console.error("[discord-interactions]", (err as Error).message);
    // The press was real and we failed it. Say so rather than pretending, and
    // leave the message's link as the way through.
    res.json(settledMessage(original, "Something went wrong. Open Cobblr to finish this."));
  }
}
