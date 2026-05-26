-- URL archive: one row per saved url. payload jsonb holds the
-- original request body verbatim so the wasm doesn't have to JSON-
-- parse in AS — Postgres extracts fields via payload->>'url' etc.
CREATE TABLE url_archive_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL,
  title text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX url_archive_items_created_at_idx
  ON url_archive_items (created_at DESC);
