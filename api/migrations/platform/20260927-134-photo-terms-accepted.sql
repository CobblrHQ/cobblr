-- When an account accepted the terms that let Cobblr keep confirmed product
-- photos as internal examples (business-models doc 25 step c, #3769).
-- PREPARED: nothing sets it yet, and nothing sends a photo without it. Null
-- means not accepted, which is every account until the updated terms ship.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_terms_accepted_at timestamptz;
