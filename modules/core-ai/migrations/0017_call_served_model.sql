-- The model that answered a call, beside the model it asked for.
--
-- A provider can serve a different model than the one named: a deprecated
-- model is redirected to its successor with no error, so a ledger that only
-- keeps the requested id labels every call (and its cost) with a model that
-- never ran. `model` stays what was asked; `served_model` is what the
-- provider's own response said answered (Gemini's and OpenAI-compatible
-- `model`, Anthropic's `model`, Ollama's `model`). Null when the response did
-- not say (a cached reply, a stream with no model frame, an older row), never
-- a copy of `model`.

alter table core_ai_calls add column if not exists served_model text;

comment on column core_ai_calls.served_model is
  'The model the provider said answered this call. Null when it did not say; never a copy of model.';
