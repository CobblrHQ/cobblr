-- Who is sending a held notice right now (#7075). A flush claims the rows it
-- will send with one UPDATE ... RETURNING, so two flushes that overlap (a
-- person's "send now" and the sweep, or two "send now"s) never both send the
-- same notice. A claim older than ten minutes is a flush that died partway, and
-- the next one takes the rows over: a notice is retried, never lost.
alter table notification_deferred add column if not exists claimed_at timestamptz;
