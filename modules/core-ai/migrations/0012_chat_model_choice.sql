-- The chat's model pill: a PER-USER choice of which AI answers their chat.
--
-- The workspace's per-job default (core_ai_capability_defaults) says which AI
-- does "chat" for everyone, and the AI settings page is where an owner sets
-- it. This is the other thing: one person, in the chat header, switching to
-- the stronger model for a hard question or to their own key for a change,
-- without touching what everyone else gets. It rides on the same row as the
-- other two pills (read my data, changes), which is the same shape of decision.
--
-- All three nullable, and null means "whatever the workspace would have
-- used": an existing row behaves exactly as before. credential_id names a
-- personal connection routed into the workspace; provider_id names one of the
-- workspace's own; model narrows either.
alter table core_ai_chat_prefs
  add column if not exists provider_id   text,
  add column if not exists model         text,
  add column if not exists credential_id text;
