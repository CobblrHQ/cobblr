UPDATE notifications AS n
SET entity_type = 'ai_held_change', entity_id = h.id
FROM ai_held_changes AS h
WHERE h.notification_id = n.id
  AND h.org_id = n.org_id
  AND n.entity_type IS NULL
  AND n.entity_id IS NULL;
