-- Which connection serves a workspace FIRST, and for what.
--
-- Two of your own keys routed to one workspace were settled by whichever row
-- had the newer updated_at: invisible, and it re-flipped when you edited the
-- other one for an unrelated reason. A boolean "primary" would fix the first
-- half only — the question is an ORDER (use A, then B), which is also the shape
-- failover needs when it arrives.
--
-- `capability` is the second axis, because one model is rarely right for
-- everything: a fast one for the live camera scan, a slower and better one for
-- inbox identification, another for chat. NULL = this ranking applies to any
-- capability with no ranking of its own, so a workspace that never splits them
-- keeps one list.
--
-- Additive and nullable: every existing route keeps working with rank NULL,
-- which sorts after anything ranked and falls back to the old recency order.
alter table user_credential_orgs add column if not exists rank integer;
alter table user_credential_orgs add column if not exists capability text;

-- One ranking row per (credential, org, capability). The partial index covers
-- the NULL-capability case, which a plain unique constraint would not.
create unique index if not exists user_credential_orgs_cap_uniq
  on user_credential_orgs (credential_id, org_id, capability)
  where capability is not null;
