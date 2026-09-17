-- Approval requests: a blocked action, asked for, decided and resumed.
--
-- A person is refused something (a capability they do not hold, a bundle
-- only the admin tier may install) and, instead of a dead end, asks. The
-- row holds what was asked (`remedies`), the words the person saw
-- (`subject`), the refused request itself so it can be finished once the
-- answer is yes (`resume`), who decided and how, and when it expires. One
-- pending row per requester and remedy set, so pressing Ask twice does not
-- send two cards. Platform-level: the approvers, the notifications and the
-- grants all live in cobblr_meta.
create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  requester_id uuid not null references users(id) on delete cascade,
  subject text not null,
  -- [{ kind: "capability" | "install", key, label }]
  remedies jsonb not null,
  -- the sorted remedy keys joined; the uniqueness handle below
  dedupe_key text not null,
  -- { method, path, body } of the refused request, replayed by the
  -- requester after a yes; null when the ask was not tied to a request
  resume jsonb,
  -- the web route the person was on when they asked; the yes reopens it
  route text,
  note text,
  -- pending | approved | denied | expired | withdrawn | resuming | completed
  status text not null default 'pending',
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  -- what apply() did per remedy, and what the replay answered
  outcome jsonb,
  -- the approvers' cards, settled when one of them answers
  approver_notification_ids jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists approval_requests_one_pending
  on approval_requests (org_id, requester_id, dedupe_key) where status = 'pending';
create index if not exists approval_requests_org_status
  on approval_requests (org_id, status, created_at desc);
create index if not exists approval_requests_requester
  on approval_requests (requester_id, created_at desc);

-- manual recovery: DROP TABLE IF EXISTS approval_requests;
