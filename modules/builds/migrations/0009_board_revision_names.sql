CREATE UNIQUE INDEX builds_board_revision_names
ON builds_builds ((metadata->'assembly'->>'project_id'), (metadata->'assembly'->>'revision'))
WHERE metadata ? 'assembly';
