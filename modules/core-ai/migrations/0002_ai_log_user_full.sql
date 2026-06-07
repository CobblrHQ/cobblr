-- AI activity log: who made each call + the FULL prompt/response (the existing
-- input_summary/output_summary stay as the short list-view preview). Full text
-- excludes large binary (base64 images are redacted before storage) and is
-- capped; a retention sweep purges old full text. user_id is null for
-- system-initiated calls (e.g. a wire firing AI).

alter table core_ai_calls add column user_id uuid;
alter table core_ai_calls add column input_full text;
alter table core_ai_calls add column output_full text;

-- Per-user activity view: their calls, newest first.
create index core_ai_calls_user_idx on core_ai_calls(user_id, invoked_at desc);
