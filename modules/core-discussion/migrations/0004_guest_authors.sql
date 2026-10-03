-- A comment from someone outside the workspace (#4627 §2: the friend's
-- comments on a shared copy appear in the original's Discussion, and the
-- owner's replies on the copy). Additive.
--
-- A guest has no account here, so the comment carries the name it arrived
-- with (author_name) and the key it arrived under (external_ref), which makes
-- a repeat delivery the same comment rather than a second one.
alter table core_discussion_comments drop constraint if exists core_discussion_author_kind_ck;
alter table core_discussion_comments add constraint core_discussion_author_kind_ck check (author_kind in ('user', 'assistant', 'guest'));
alter table core_discussion_comments add column if not exists author_name text;
alter table core_discussion_comments add column if not exists external_ref text;
create unique index if not exists core_discussion_comments_external_ref on core_discussion_comments(external_ref) where external_ref is not null;
