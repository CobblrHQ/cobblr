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
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import {
  INTERACTION,
  RESPONSE,
  parsePress,
  resolvePress,
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
 *  token can do is replay a press its holder was already shown. */
discordInteractionsRouter.post(
  "/discord/interactions/forwarded",
  requireAuth,
  async (req, res) => {
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
  if (body.type !== INTERACTION.COMPONENT) {
    res.status(204).end();
    return;
  }

  const original = body.message?.content ?? "";
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
        .select(["id", "org_id", "user_id", "actions"])
        .where("id", "=", ref.notificationId)
        .executeTakeFirst(),
      discordUserId
        ? meta
            .selectFrom("discord_connections")
            .select(["user_id"])
            .where("discord_user_id", "=", discordUserId)
            .where("verified", "=", true)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);

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

    await platform().actions.invoke(resolved.action, {
      orgId: resolved.orgId,
      userId: resolved.userId,
      event: {
        name: "platform.notification.action",
        payload: { notificationId: ref.notificationId, actionId: ref.actionId },
        // "session" because a PERSON did this, having proved who they are —
        // the vocabulary has no term for "acting through a linked third-party
        // identity", and inventing one here would widen a platform enum every
        // activity-log reader depends on. The provenance is not lost: the
        // event payload names the notification and the action, so the trail
        // says Discord even though this field cannot.
        actor: { user_id: resolved.userId, display_name: null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args: resolved.args,
    });

    res.json(settledMessage(original, `✅ ${resolved.label}`));
  } catch (err) {
    console.error("[discord-interactions]", (err as Error).message);
    // The press was real and we failed it. Say so rather than pretending, and
    // leave the message's link as the way through.
    res.json(settledMessage(original, "Something went wrong. Open Cobblr to finish this."));
  }
}
