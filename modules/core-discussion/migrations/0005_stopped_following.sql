-- Not following is something to remember, not an absence.
--
-- Anyone who has spoken in a conversation hears it, follow row or not, because
-- a workspace older than following still has conversations in it. So deleting
-- the row on Stop changed nothing for them: the bell said they had stopped and
-- the next comment reached them anyway. A 'muted' row is what that rule reads.
--
-- Additive: one more allowed value, nothing existing changes.
alter table core_discussion_follows drop constraint if exists core_discussion_follow_reason_ck;
alter table core_discussion_follows add constraint core_discussion_follow_reason_ck
  check (reason in ('commented', 'mentioned', 'explicit', 'muted'));
