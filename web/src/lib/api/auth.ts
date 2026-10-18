import type { SessionUser } from "./account";
import type { OrgMembership } from "./members";
import { request, setToken } from "./client";

export interface AuthResponse {
  token: string;
  user: SessionUser;
  orgs: OrgMembership[];
}

/** The trial ledger, read back (api/src/platform/trial-ledger.ts). Every line
 *  has `words` a person can read; the rest is what a replay needs. */
export interface SandboxLedger {
  since: string | null;
  bundles: Array<{ external_id: string; version: string; name: string; words: string }>;
  modules: Array<{ module_name: string; name: string; words: string }>;
  instances: Array<{ module_name: string; instance_name: string; display_name: string; words: string }>;
  fields: Array<{ id: string; entity_kind: string; name: string; display_label: string; type: string; words: string }>;
  automations: Array<{ id: string; source_kind: string; action_id: string; words: string }>;
  scans: Array<{ entity_kind: string; entity_id: string; instance: string | null; name: string; photo_file_ids: string[]; words: string }>;
  records: Array<{ entity_kind: string; label: string; ids: string[]; scanned: number; words: string }>;
  left_behind: string[];
}

/** A carried trial, before anything comes: the list its ending showed. */
export interface CarryPreview {
  /** The trial; its id keeps it out of the workspaces offered to bring it into. */
  workspace: { id: string; name: string };
  ledger: SandboxLedger;
  /** Homes a record needs that the person did not make (a stock collection). */
  homes: { bundles: string[]; instances: string[]; modules: string[] };
  unread: Array<{ kind: string; id: string; reason: string }>;
}

export interface InvitePreview {
  id: string;
  role: OrgMembership["role"];
  invited_email: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  org_name: string;
  org_slug: string;
  invited_by_name: string;
  status: "open" | "consumed" | "revoked" | "expired" | "full" | "paused";
  reusable?: boolean;
}

export const authApi = {
  authConfig: () =>
    request<{
      product_name?: string;
      signup_enabled: boolean;
      self_serve_invites?: boolean;
      hosted?: boolean;
      /** This server can send Web Push (its key pair exists); null when it could not say. */
      web_push?: boolean | null;
      captcha?: { provider: string; site_key: string | null } | null;
      /** Present only when this surface can BOTH reach the account service and redeem
       *  a code from it. Null means "no such button", not "not configured yet". */
      identity?: { authorize_url: string; deployment: string; name?: string } | null;
      /** A public demo's shared login, to show and pre-fill. Null on every instance
       *  that has not deliberately published one. */
      demo_signin?: { email: string; password: string; note: string | null } | null;
      /** An Offline CA install's root certificate, on plain HTTP, for a phone to
       *  trust once before its camera works. Null on every other install. */
      phone_certificate_url?: string | null;
    }>("GET", "/auth/config"),
  signup: (body: {
    email: string;
    password: string;
    display_name: string;
    org_name?: string;
    invite_token?: string;
    /** A share invite the person is signing up to accept (#4737). */
    share_invite?: string;
    /** Managed-app signup: provision the first workspace as this app. */
    app?: string;
    manifest?: unknown;
    /** Captcha token (e.g. Turnstile), required only when the server has a
     *  captcha provider configured (the trial tier). */
    captcha_token?: string;
    /** The link or QR that sent the person here, for the signed_up event. */
    source?: string;
  }) =>
    request<AuthResponse | { needs_verification: true; email: string }>("POST", "/auth/signup", body),
  // Public preview of a single-use signup invite (the /join/:token page).
  previewSignupInvite: (token: string) =>
    request<{ status: string; invited_email: string | null; note: string | null; blueprint_name?: string | null }>(
      "GET",
      `/auth/signup-invite/${encodeURIComponent(token)}`,
    ),
  /** `app` / `source`: where an unconfirmed central account comes back to after
   *  the fresh confirmation link the sign-in sends it. */
  login: (body: { email: string; password: string; app?: string; source?: string }) =>
    request<AuthResponse>("POST", "/auth/login", body),
  /** Make the central Cobblr account from this page. Always "check your email":
   *  nobody is signed in until the address is confirmed, and the link brings
   *  them back through /auth/callback with the app and source. */
  identitySignup: (body: { display_name: string; email: string; password: string; captcha_token?: string; app?: string; source?: string; accept_terms?: boolean }) =>
    request<{ status: "check_your_email" }>("POST", "/auth/identity/signup", body),
  /** `next` is the page to land on; `invite` a workspace invite the link
   *  redeems as it signs in (how someone without a password joins). */
  magicRequest: (body: { email: string; next?: string; invite?: string; display_name?: string }) =>
    request<{
      ok: boolean;
      expires_at: string;
      message: string;
      /** Dev mode only — non-prod returns the plaintext + a link. */
      dev_token?: string;
      dev_link?: string;
    }>("POST", "/auth/magic/request", body),
  magicConsume: (body: { token: string }) =>
    request<AuthResponse & { next?: string | null }>("POST", "/auth/magic/consume", body),
  // Central identity: trade the one-time code from account.cobblr.xyz for a session
  // here. The code arrives in the URL; the identity token never does (the api redeems
  // it server to server). See docs/architecture/central-identity.md.
  /** The instance's own sign-in providers (#4492), and whether password
   *  sign-in is on. Public: the sign-in page reads it. */
  oidcProviders: () => request<{ items: Array<{ slug: string; display_name: string }>; password_signin: boolean }>("GET", "/auth/oidc/providers"),
  /** The one-time code the provider's callback handed the browser, for a session. */
  oidcRedeem: (body: { code: string }) => request<AuthResponse & { signed_in_with: string }>("POST", "/auth/oidc/redeem", body),
  /** The provider's sign-out address, when it has one. */
  oidcSignOut: (slug: string) => request<{ url: string | null }>("GET", `/auth/oidc/${encodeURIComponent(slug)}/sign-out`),
  /** `app` is the managed app asked for on /start/<app>; `provisioned` says what
   *  this sign-in made (null when an existing account was adopted). */
  identityCallback: (body: { code: string; app?: string; source?: string }) =>
    request<AuthResponse & { provisioned: { slug: string; app: string | null } | null }>(
      "POST",
      "/auth/identity/callback",
      body,
    ),
  // QR pair-login (desktop mints a code → phone scans + claims → signed in to
  // the same workspace). See api/src/routes/auth.ts "QR pair-login".
  pairStart: (body: { org_slug: string }) =>
    request<{
      code: string;
      expires_at: string;
      /** The URL the QR encodes (= claim_options[0]). */
      claim_url: string;
      /** Candidate claim URLs (request origin + optional PUBLIC_BASE_URL). */
      claim_options: { label: string; url: string }[];
    }>("POST", "/auth/pair/start", body),
  pairStatus: (code: string) =>
    request<{ state: "pending" | "claimed" | "expired" }>(
      "POST",
      `/auth/pair/status`,
      { code },
    ),
  pairClaim: (code: string) =>
    // Unauthenticated — the phone has no session yet. Returns the normal auth
    // response PLUS the workspace slug to make active (null if membership was
    // revoked between mint and claim → client falls back to the default).
    request<AuthResponse & { target_org_slug: string | null }>(
      "POST",
      "/auth/pair/claim",
      { code },
    ),
  // Password reset (forgot → email link → set new password, auto-login).
  passwordForgot: (body: { email: string }) =>
    request<{
      ok: boolean;
      message: string;
      /** Dev mode only — non-prod with no email sender returns the link. */
      dev_token?: string;
      dev_link?: string;
    }>("POST", "/auth/password/forgot", body),
  passwordReset: (body: { token: string; password: string }) =>
    request<AuthResponse>("POST", "/auth/password/reset", body),
  /** The new address's link: makes the change; every session ends. */
  confirmEmailChange: (body: { token: string }) => request<{ email: string }>("POST", "/auth/email-change/confirm", body),
  /** The old address's link: takes the account back, and answers the reset
   *  that sets its new password (the old one is cleared). */
  revertEmailChange: (body: { token: string }) => request<{ email: string; reset_token?: string }>("POST", "/auth/email-change/revert", body),
  verifyEmail: (body: { token: string }) =>
    request<{ ok: boolean; email: string }>("POST", "/auth/verify-email", body),
  previewInvite: (token: string) =>
    request<InvitePreview>("GET", `/invites/${token}`),
  acceptInvite: (token: string) =>
    request<{ org: OrgMembership; already_member: boolean }>(
      "POST",
      `/invites/${token}/accept`,
    ),

  declineInvite: (token: string) =>
    request<{ declined: boolean; already_answered: boolean }>(
      "POST",
      `/invites/${token}/decline`,
    ),
  // New user (no account) signs up AND joins the inviting workspace.
  acceptInviteAsNewUser: (
    token: string,
    body: { email: string; password: string; display_name: string },
  ) => request<AuthResponse>("POST", `/invites/${token}/accept-signup`, body),
  /** Whether this deployment lets an AI assistant's connector sign in (OAuth), and its MCP URL. */
  oauthStatus: (slug: string) => request<{ available: boolean; mcp_url: string }>("GET", `/oauth/status?workspace=${encodeURIComponent(slug)}`),
  /** The consent screen's facts about a connector's sign-in request (query string as sent). */
  oauthAuthorizeCheck: (query: string) =>
    request<{
      client_name: string | null;
      redirect_host: string;
      wants_changes: boolean;
      workspaces: Array<{ id: string; name: string; slug: string }>;
    }>("GET", `/oauth/authorize/check?${query}`),
  oauthApprove: (body: Record<string, string | undefined>) =>
    request<{ redirect: string }>("POST", "/oauth/authorize", body),
  /** Bind an email to a no-account sandbox: it becomes an ordinary account
   *  trial. `emailed` says whether the sign-in link actually went - when it did
   *  not, the anonymous link is deliberately left working, because it is then
   *  the only way back in. Branch on it rather than promising an inbox. */
  /** The two ways to carry on, from the server so the modal and the email can
   *  never disagree about where they point. */
  sandboxPaths: () =>
    request<{
      cloud_url: string | null;
      selfhost_url: string | null;
      export_days: number;
      /** How long keeping makes it a trial here. The server's setting, not a choice. */
      trial_days: number;
      /** How long a sandbox past its hour is held so it can still be kept. */
      decision_hours: number;
      /** Whether a real account can carry what was built here (the ledger replay). */
      carry_available: boolean;
    }>("GET", "/try/paths"),
  /** What the person built in their sandbox, net of what they deleted and
   *  never the stock: the list the ending page shows, and later the picker
   *  for bringing it along. Their own sandbox or kept trial, found through
   *  their link, so it reads past the hour when every workspace route is 410. */
  sandboxLedger: () => request<SandboxLedger>("GET", "/try/ledger"),
  /** What is true of the sandbox's work right now (open, held, kept, gone). */
  sandboxLifetime: () => request<import("@cobblr/platform-contract/sandbox-lifetime").SandboxLifetime>("GET", "/try/lifetime"),
  /** The person's grant for another deployment to read this kept trial, and
   *  this box's public address for it to read from. */
  startCarry: () => request<{ token: string; source: string; expires_hours: number }>("POST", "/try/carry", {}),
  /** On the receiving side: the list the trial's ending showed, read through
   *  the grant, before anything is brought. */
  carryPreview: (from: string, token: string) =>
    request<CarryPreview>("GET", `/carry/preview?from=${encodeURIComponent(from)}&token=${encodeURIComponent(token)}`),

  /** "Email me my work": builds the workspace backup, keeps it for a short
   *  window and emails a link. `emailed` false still means the file exists -
   *  the link comes back either way. */
  takeSandboxWork: (email: string, keepExamples = false) =>
    request<{ ok: boolean; emailed: boolean; link: string; expires_at: string; days: number }>(
      "POST",
      "/try/take",
      { email, ...(keepExamples ? { keep_examples: true } : {}) },
    ),

  /** Clear a sandbox's records, keeping its modules, fields and views. */
  emptySandbox: () => request<{ deleted: number; failed: number }>("POST", "/try/empty", {}),

  /** Keep the sandbox as a trial. How long is the server's setting, returned as `days`. */
  keepSandbox: (email: string) =>
    request<{ ok: boolean; kind: "trial" | "join_pending"; expires_at: string; emailed: boolean; days: number }>("POST", "/try/keep", { email }),

  /** Send the kept workspace's sign-in link again. */
  resendSandboxLink: () =>
    request<{ ok: boolean; emailed: boolean; email: string }>("POST", "/try/resend-link", {}),

  /** Choose a password for a kept sandbox. Revokes every other session and the
   *  anonymous link; the response carries a fresh token for THIS tab. */
  setSandboxPassword: async (password: string) => {
    const res = await request<{ ok: boolean; token: string; email: string }>("POST", "/try/set-password", {
      password,
    });
    if (res?.token) setToken(res.token);
    return res;
  },

  // Marketplace v0.3.x — operator browses the cobblr registry +
  // installs sandboxed modules at runtime.
  sandboxRegistry: (url?: string) => {
    const qs = url ? `?url=${encodeURIComponent(url)}` : "";
    return request<{
      items: Array<{
        name: string;
        display_name?: string;
        description?: string;
        band: string;
        author?: string;
        homepage?: string;
        public_key_ed25519: string | null;
        versions: Array<{
          version: string;
          released_at?: string;
          source_url: string;
          sha256: string | null;
          signature: string | null;
          notes?: string;
        }>;
        installed: { name: string; version: string; source: string } | null;
      }>;
    }>("GET", `/sandbox/registry${qs}`);
  },
  sandboxInstall: (body: { name: string; version: string; registry_url?: string }) =>
    request<{ ok: boolean; name: string; version: string; routes: Array<{ method: string; path: string }> }>(
      "POST",
      `/sandbox/install`,
      body,
    ),
  sandboxUninstall: (name: string) =>
    request<{
      ok: boolean;
      name: string;
      removed_from_registry: boolean;
      removed_dir: string | null;
    }>("DELETE", `/sandbox/install/${encodeURIComponent(name)}`),
};
