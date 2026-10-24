-- Keep one finish intent before recording glaze use.
-- Manual recovery: this additive statement can be rerun after interruption.
ALTER TABLE digifab_firings ADD COLUMN IF NOT EXISTS finish_intent jsonb;
