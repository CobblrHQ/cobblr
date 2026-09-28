-- HOW an action was made, beside who made it (#3833).
--
-- A row already says who (user_id), how they signed in (auth_method) and with
-- which token (api_token_id). It could not say that the write came through an
-- assistant over MCP, through the in-app assistant, or from an automation, so
-- a record an assistant created read exactly like a hand edit, and a record an
-- automation created had no actor at all and read "someone created …".
-- Additive and nullable: older rows simply have no via.
alter table activity_log add column if not exists via_kind text;
alter table activity_log add column if not exists via_label text;
