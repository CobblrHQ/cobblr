-- Sign in with the instance's own OpenID Connect provider (Authentik,
-- Authelia, Keycloak, Pocket ID…), #4492. Additive: new tables only.
--
--   oidc_providers     the providers an operator set up (Super admin → Sign-in,
--                      or COBBLR_OIDC_* at first boot). The client secret is
--                      encrypted with the instance key (db/crypto.ts) and never
--                      leaves the api.
--   user_oidc_links    which provider account (issuer + subject) is which
--                      Cobblr user. Made only with proof: by a person already
--                      signed in here, or by the provider creating the account
--                      when the operator allows it. Never by a matching email.
--   oidc_logins        one row per sign-in started: state, nonce and the PKCE
--                      verifier, kept here (hashed state) so the callback can
--                      check every one; single use, ten minutes.
--   oidc_handoffs      the one-time code the callback hands the browser, traded
--                      for a session by POST, so no session token ever rides in
--                      a URL.
--   instance_sign_in   one row: whether password (and email-link) sign-in is on.
CREATE TABLE IF NOT EXISTS oidc_providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  display_name       text NOT NULL,
  issuer             text NOT NULL,
  client_id          text NOT NULL,
  client_secret_enc  text,
  scopes             text NOT NULL DEFAULT 'openid email profile groups',
  email_claim        text NOT NULL DEFAULT 'email',
  groups_claim       text NOT NULL DEFAULT 'groups',
  allow_signup       boolean NOT NULL DEFAULT false,
  signup_groups      text[] NOT NULL DEFAULT '{}',
  group_roles        jsonb NOT NULL DEFAULT '[]',
  allow_http         boolean NOT NULL DEFAULT false,
  enabled            boolean NOT NULL DEFAULT true,
  from_env           boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_oidc_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id    uuid NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
  subject        text NOT NULL,
  email_at_link  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  UNIQUE (provider_id, subject),
  UNIQUE (provider_id, user_id)
);
CREATE INDEX IF NOT EXISTS user_oidc_links_user_idx ON user_oidc_links (user_id);

CREATE TABLE IF NOT EXISTS oidc_logins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash     text NOT NULL UNIQUE,
  nonce          text NOT NULL,
  code_verifier  text NOT NULL,
  redirect_uri   text NOT NULL,
  provider_id    uuid NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
  purpose        text NOT NULL CHECK (purpose IN ('signin', 'link')),
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  consumed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS oidc_handoffs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash    text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id  uuid NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  consumed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS instance_sign_in (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  password_signin   boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance_sign_in (id) VALUES (true) ON CONFLICT DO NOTHING;
