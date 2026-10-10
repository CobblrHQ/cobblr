-- A person's own default AI per job (#5404): for each of the four jobs
-- (photos, chat, text, search) the steps to ask in order, each one of their
-- own AI connections and a model. Position 0 is First, 1 and on are Then.
-- Every workspace they use follows these unless the workspace chose for the
-- job itself. A step names only the person's own connections, and goes with
-- the connection or the person. Additive.
--
-- A step may follow a family's latest (claude-haiku-latest), the way a
-- workspace's choice does (core-ai migration 0016): `model` always names a
-- model the provider serves, so an api that reads only it sends something
-- real, and `model_follows` holds the latest that was picked. The router
-- reads `model_follows` first and asks the provider's listing what it means
-- on each call. Null = `model` is an exact version, pinned. No row predates
-- the column: both ship in this file.
CREATE TABLE IF NOT EXISTS user_ai_job_defaults (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job text NOT NULL CHECK (job IN ('photos', 'chat', 'text', 'search')),
  position smallint NOT NULL CHECK (position >= 0),
  credential_id uuid NOT NULL REFERENCES user_credentials(id) ON DELETE CASCADE,
  model text NOT NULL,
  model_follows text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job, position)
);
CREATE INDEX IF NOT EXISTS user_ai_job_defaults_by_connection ON user_ai_job_defaults (credential_id);
COMMENT ON COLUMN user_ai_job_defaults.model_follows IS
  'A family''s latest (claude-haiku-latest) when that was picked; the call then uses the newest listed model of the family. Null = model is an exact choice.';
