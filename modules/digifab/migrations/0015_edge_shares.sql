-- Edge-bridge machine SHARES. A workspace that runs an edge bridge can invite a
-- PERSON to a checklist of its bridge machines (edge_adapter connections) via a
-- link. The recipient decides which of THEIR workspace(s) to add the machines to
-- — one grant can be redeemed into several. The recipient's workspaces never hold
-- the machine's credentials — each gets a pointer connection, and the relay
-- assembles every request from THIS (the owner's) config at send time, enforcing
-- the scope + the grant's revoked/expiry status live. Because the live check is
-- on the GRANT, one revoke cuts off every workspace that redeemed it.
--
--   scope:        'read'  → monitor only (the relay blocks every write/control path)
--                 'write' → full control (send/pause/cancel)
--   instances:    the owner's edge_adapter connection ids this grant covers
--   grantee_orgs: [{ org, label, at }] — the workspaces that redeemed it
--   token valid until revoked/expired (re-redeemable into more of the recipient's
--   workspaces); revoke clears the token + flips revoked_at.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_edge_shares;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0015_edge_shares';
create table if not exists digifab_edge_shares (
  id            uuid primary key default gen_random_uuid(),
  label         text not null,
  scope         text not null,                  -- 'read' | 'write'
  instances     jsonb not null default '[]'::jsonb,
  token_hash    text,                           -- sha256 of the invite; cleared on revoke
  grantee_orgs  jsonb not null default '[]'::jsonb,  -- [{ org, label, at }] redeemers
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  redeemed_at   timestamptz,                    -- first redemption
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
