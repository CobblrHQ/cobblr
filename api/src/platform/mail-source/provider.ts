// Gmail in the personal-connections catalogue: kind 'mail-source', a Connect
// button rather than credential fields, and the one editable non-secret
// field (the stores a person adds to the allowlist). Registered only when a
// Google client is configured; a self-host without one lists nothing and
// the forwarding address remains the door.

import { platform } from "@cobblr/platform-contract";
import { googleOAuthConfigured, revokeGoogleToken } from "./google-oauth.js";
import { GMAIL_PROVIDER_ID, MAIL_SOURCE_KIND } from "./store.js";

export const GMAIL_START_PATH = "/me/mail-sources/gmail/start";

export function registerGmailProvider(): boolean {
  if (!googleOAuthConfigured()) {
    console.log("[mail-source] Gmail not offered: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET unset");
    return false;
  }
  platform().connections.registerProvider({
    id: GMAIL_PROVIDER_ID,
    kind: MAIL_SOURCE_KIND,
    label: "Gmail",
    blurb: "Reads mail from stores and carriers only, read-only, so your orders and parcels track themselves.",
    connect: { kind: "oauth", start: GMAIL_START_PATH },
    credentials: {
      // The address is read from the grant, never typed; it is here so the
      // card can show it as a non-secret value.
      email: { label: "Mailbox", secret: false },
      extra_senders: { label: "Stores you add (domains, comma separated)", secret: false },
      refresh_token: { label: "Grant", secret: true },
    },
    onDelete: async (credentials) => {
      const token = typeof credentials.refresh_token === "string" ? credentials.refresh_token : "";
      if (!token) return;
      const ok = await revokeGoogleToken(token);
      if (!ok) console.warn("[mail-source] revoke at Google did not succeed; the local grant is deleted regardless");
    },
  });
  return true;
}
