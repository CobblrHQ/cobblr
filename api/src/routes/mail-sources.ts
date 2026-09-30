// A person's connected mailboxes (the Gmail door of receipts-by-email).
//
//   POST /me/mail-sources/gmail/start        {org_id} → {url}: the consent screen
//   GET  /me/mail-sources/gmail/callback     Google lands here; stores the grant
//   GET  /me/mail-sources                    the card: address, workspace, state
//   POST /me/mail-sources/:id/sync           Check now (a stopped source is retried)
//   GET  /orgs/:slug/mail-sources            the workspace's view: who feeds it
//
// The connection itself is an ordinary personal connection (kind
// 'mail-source'), so routing, the write-only secret, editing the allowlist
// and Disconnect all go through /me/connections; these routes are only the
// consent round trip and the state beside it.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { publicBaseUrl } from "../platform/public-url.js";
import { addUserCredential, updateUserCredential, listUserCredentials } from "../platform/user-credentials.js";
import { beginGoogleConsent, exchangeGoogleCode, googleOAuthConfigured, googleRedirectUri, readGoogleState } from "../platform/mail-source/google-oauth.js";
import { GmailSource } from "../platform/mail-source/gmail.js";
import { GMAIL_PROVIDER_ID, MAIL_SOURCE_KIND, mailSourceStates, mailSourcesRoutedTo, myMailSources, writeMailSourceState } from "../platform/mail-source/store.js";
import { BACKFILL_DAYS, syncCredential } from "../platform/mail-source/sync.js";

export const mailSourcesRouter = Router();
export const workspaceMailSourcesRouter = Router({ mergeParams: true });

const StartBody = z.object({ org_id: z.string().uuid() });

// AI-REACH: a consent screen the person has to click through themselves; an
// assistant cannot grant access to somebody's mailbox.
// UI-SCREEN: /me/connections
mailSourcesRouter.post("/me/mail-sources/gmail/start", requireAuth, async (req, res, next) => {
  try {
    if (!googleOAuthConfigured()) {
      res.status(503).json({ error: { code: "not_configured", message: "Gmail isn't set up on this server yet." } });
      return;
    }
    const parsed = StartBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "org_id required" } });
      return;
    }
    const member = await meta
      .selectFrom("org_memberships")
      .select("org_id")
      .where("user_id", "=", req.session!.id)
      .where("org_id", "=", parsed.data.org_id)
      .executeTakeFirst();
    if (!member) {
      res.status(403).json({ error: { code: "not_a_member", message: "Can only feed a workspace you belong to." } });
      return;
    }
    const { url } = await beginGoogleConsent(req.session!.id, parsed.data.org_id);
    res.json({ url, redirect_uri: googleRedirectUri() });
  } catch (err) {
    next(err);
  }
});

// Google redirects the browser here. Never a 4xx: a person is looking at it,
// so every outcome is a redirect back to Connections with a word in the query.
mailSourcesRouter.get("/me/mail-sources/gmail/callback", async (req, res) => {
  // Back to the surface the person connected FROM: the registered redirect's
  // origin. A canary slot shares its .env (and so PUBLIC_BASE_URL) with the
  // pinned deployment and differs only in its own GOOGLE_OAUTH_REDIRECT_URI;
  // returning to PUBLIC_BASE_URL would land a canary tester on the other one.
  const origin = (() => {
    try {
      return new URL(googleRedirectUri()).origin;
    } catch {
      return publicBaseUrl();
    }
  })();
  const back = (word: string) => res.redirect(`${origin}/me/connections?gmail=${word}`);
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (typeof req.query.error === "string") return back("denied");
    const claims = state ? await readGoogleState(state) : null;
    if (!code || !claims) return back("error");
    const grant = await exchangeGoogleCode(code, claims.verifier);
    if (!grant) return back("error");
    const profile = await new GmailSource({ accessToken: grant.access_token }).profile().catch(() => null);
    const email = profile?.email ?? null;

    // Reconnecting the same mailbox replaces its grant rather than adding a
    // second connection that would read the same mail twice.
    const existing = (await listUserCredentials(claims.userId, (_p, k) => k === "refresh_token"))
      .filter((c) => c.kind === MAIL_SOURCE_KIND && c.provider_id === GMAIL_PROVIDER_ID)
      .find((c) => email && (c.credential_values.email ?? "").toLowerCase() === email.toLowerCase());
    let credentialId: string;
    if (existing) {
      credentialId = existing.id;
      await updateUserCredential(claims.userId, credentialId, {
        credentials: { refresh_token: grant.refresh_token, ...(email ? { email } : {}) },
        routes: [{ org_id: claims.orgId, mode: "workspace-default", primary: true }],
      });
      await writeMailSourceState(credentialId, { status: "ok", last_error: null, stopped_notified_at: null });
    } else {
      credentialId = await addUserCredential(claims.userId, {
        provider_id: GMAIL_PROVIDER_ID,
        kind: MAIL_SOURCE_KIND,
        label: email ?? "Gmail",
        credentials: { refresh_token: grant.refresh_token, ...(email ? { email } : {}), extra_senders: "" },
        routes: [{ org_id: claims.orgId, mode: "workspace-default", primary: true }],
      });
    }

    // The backfill runs behind the redirect: the person is back on the page
    // in a second, and the first parcels appear as it walks.
    void syncCredential({ credentialId, ownerUserId: claims.userId, orgId: claims.orgId, force: true }).catch((err) => {
      console.error("[mail-source] first sync failed:", (err as Error).message);
    });
    try {
      await platform().notifications.dispatch({
        orgId: claims.orgId,
        userId: claims.userId,
        eventType: "platform.mail_source.connected",
        message: `Gmail connected${email ? ` (${email})` : ""}. Reading store mail from the last ${BACKFILL_DAYS} days and from now on.`,
        // PAGE-LINK: a mailbox connection has no record of its own; the card lives on /me/connections
        link_url: "/me/connections",
        card: {
          heading: existing ? "Gmail reconnected" : "Gmail connected",
          body: `Reading mail from stores and carriers only, read-only. The last ${BACKFILL_DAYS} days first, then as it arrives.`,
          ...(email ? { context: email } : {}),
        },
        payload: { credential_id: credentialId },
      });
    } catch (err) {
      console.error("[mail-source] connected card failed:", (err as Error).message);
    }
    return back(existing ? "reconnected" : "connected");
  } catch (err) {
    console.error("[mail-source] callback failed:", (err as Error).message);
    return back("error");
  }
});

mailSourcesRouter.get("/me/mail-sources", requireAuth, async (req, res, next) => {
  try {
    res.json({ configured: googleOAuthConfigured(), items: await myMailSources(req.session!.id) });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: the person's own mailbox, read on their say-so; the sweep does
// this on its own every five minutes and an assistant has no reason to.
mailSourcesRouter.post("/me/mail-sources/:id/sync", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id ?? "";
    const mine = (await myMailSources(req.session!.id)).find((m) => m.id === id);
    if (!id || !mine) {
      res.status(404).json({ error: { code: "not_found", message: "No such mailbox." } });
      return;
    }
    const orgId = mine.org_ids[0];
    if (!orgId) {
      res.status(409).json({ error: { code: "not_routed", message: "This mailbox feeds no workspace yet." } });
      return;
    }
    const out = await syncCredential({ credentialId: id, ownerUserId: req.session!.id, orgId, force: true });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// The workspace's side: which mailboxes feed it, whose, and how fresh. An
// admin sees that a mailbox is connected; only its owner can open it.
workspaceMailSourcesRouter.get("/:slug/mail-sources", requireAuth, withTenant, async (req, res, next) => {
  try {
    const orgId = req.tenant!.org.id;
    const routed = await mailSourcesRoutedTo(orgId);
    const states = await mailSourceStates(routed.map((r) => r.credentialId));
    const ownerIds = [...new Set(routed.map((r) => r.ownerUserId))];
    const owners = ownerIds.length
      ? await meta.selectFrom("users").select(["id", "display_name"]).where("id", "in", ownerIds).execute()
      : [];
    const nameOf = new Map(owners.map((u) => [u.id, u.display_name]));
    // The address belongs to the owner's card; the workspace sees the
    // provider, the person, and the state, which is what "is it feeding us"
    // needs and nothing more.
    res.json({
      items: routed.map((r) => {
        const st = states.get(r.credentialId);
        return {
          id: r.credentialId,
          provider_id: r.providerId,
          owner_user_id: r.ownerUserId,
          owner_name: nameOf.get(r.ownerUserId) ?? null,
          approved: r.approved,
          mine: r.ownerUserId === req.session!.id,
          status: st?.status ?? "ok",
          last_synced_at: st?.last_synced_at ?? null,
          messages_seen: st?.messages_seen ?? 0,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});
