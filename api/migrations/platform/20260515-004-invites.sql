-- Workspace invitations.
--
-- A row here is a shareable-link token: the inviter creates one,
-- copies the URL, sends it to whoever should join. The accept
-- endpoint validates the token, creates an org_memberships row
-- for the current user with the recorded role, and marks the
-- invite consumed.
--
-- Email is optional — we don't have SMTP yet, so a token is the
-- core artifact. When email is supplied, it's a hint for the
-- claim flow (pre-filling, future expiry-on-mismatch) but the
-- token alone is sufficient to claim. That's the same model
-- GitHub uses for "anyone with the link can join."

create table workspace_invites (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  invited_by_user   uuid not null references users(id),
  -- Token is the URL slug — long random, base64url-friendly. The
  -- accept flow looks the invite up by token under a unique index.
  token             text not null unique,
  -- Optional hint for the recipient's email. Not enforced today.
  invited_email     text,
  role              text not null
                      check (role in ('owner', 'admin', 'member', 'guest')),
  expires_at        timestamptz,
  consumed_at       timestamptz,
  consumed_by_user  uuid references users(id),
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);

create index workspace_invites_org_idx on workspace_invites(org_id);
create index workspace_invites_open_idx
  on workspace_invites(org_id)
  where consumed_at is null and revoked_at is null;
