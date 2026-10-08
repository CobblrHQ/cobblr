-- Web Push (#5267): a notification on a person's phone or desktop, the iPhone
-- Home Screen app included, sent from this instance straight to the browser
-- vendors' push services. Additive.

-- The instance's VAPID key pair, made once on first boot (or given by the
-- operator) and kept: every subscription a browser holds is bound to the
-- public key, so a new pair would orphan every device. The private key is
-- encrypted with the instance's credential key, like a tenant's creds.
CREATE TABLE IF NOT EXISTS push_vapid_keys (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key text NOT NULL,
  private_key_enc text NOT NULL,
  source text NOT NULL DEFAULT 'generated',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per browser on one device: an endpoint at a push service and the
-- keys a payload is encrypted to. A person has several; an endpoint the push
-- service says is gone (404, 410) is deleted.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL: every workspace the person is in. A workspace id: only that one.
  org_id uuid REFERENCES orgs(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  label text NOT NULL DEFAULT 'This device',
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure text,
  failures_in_a_row integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_by_person ON push_subscriptions (user_id);

-- A person's push settings, across their devices: what is worth buzzing a
-- phone for (high and urgent by default, the bell keeps the rest), and quiet
-- hours that hold everything but urgent until they end.
CREATE TABLE IF NOT EXISTS push_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  min_priority text NOT NULL DEFAULT 'high' CHECK (min_priority IN ('low', 'normal', 'high', 'urgent')),
  quiet_start_minute integer CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute integer CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  timezone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now()
);
