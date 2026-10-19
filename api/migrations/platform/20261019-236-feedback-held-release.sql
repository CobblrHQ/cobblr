-- Resolving a feedback item never publishes (#7460).
--
-- A resolve by an API token used to post the public summary to the public
-- Discord feedback channel and message the reporter in the same call. Both are
-- now held on the item until the owner publishes them from the operator UI:
-- held_summary is the third-person line for the public card, held_reply the
-- reporter-facing message, published_at when the owner released them.
--
-- Additive and nullable; an item resolved before this column existed has
-- nothing held, which is honest.
alter table feedback add column if not exists held_summary text;
alter table feedback add column if not exists held_reply jsonb;
alter table feedback add column if not exists published_at timestamptz;
