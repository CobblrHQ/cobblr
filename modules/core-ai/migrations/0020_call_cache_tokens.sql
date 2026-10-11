-- Prompt-cache tokens per call (#5319). Anthropic reports the prompt tokens
-- it read from its cache and wrote to it apart from the rest of the input;
-- the cost already prices them (a read at a tenth of the input rate, a write
-- at 1.25 times), and these columns let the AI page say how much of a call
-- came from the cache. Null for a call before this, or a provider without a
-- cache it reports.
alter table core_ai_calls add column if not exists cache_read_tokens integer;
alter table core_ai_calls add column if not exists cache_write_tokens integer;
