-- Conversational tickets: a feedback item can grow a thread of follow-up
-- messages (a Discord support ticket where the reporter replies "still broken"
-- + attaches more info/images, or "thanks"). The original report stays in
-- `message`; each follow-up appends here. Re-triage runs over message + these.
--
-- Each element: { at: text(iso), from: text, text: text, images: [{url, name}] }
--
-- manual recovery if this fails partway:
--   ALTER TABLE feedback DROP COLUMN IF EXISTS followups;
--   DELETE FROM migrations WHERE name = '20260609-052-feedback-followups.sql';

alter table feedback add column followups jsonb not null default '[]'::jsonb;

-- The append-by-thread lookup hits origin_ref->>'thread_id' on every follow-up.
create index if not exists feedback_origin_thread_idx
  on feedback ((origin_ref ->> 'thread_id'));
