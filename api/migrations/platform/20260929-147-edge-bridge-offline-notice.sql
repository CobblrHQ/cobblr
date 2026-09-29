-- When the workspace was told this bridge went offline; cleared when it is
-- heard from again. Null while nothing is outstanding.
ALTER TABLE edge_bridges ADD COLUMN IF NOT EXISTS offline_noticed_at timestamptz;
