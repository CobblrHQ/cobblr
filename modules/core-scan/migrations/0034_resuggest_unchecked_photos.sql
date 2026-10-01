-- Look again at every picture suggested before suggestions were checked (#4373).
--
-- Until now the suggestion pass took the search's best title overlap, or its
-- first answer, without asking whether the picture showed the record. Three
-- printers named after the sheet-metal shop that built them were each
-- offered that shop's marketing banner. A suggestion still waiting for an
-- answer goes back in the queue, so the pass finds it again under the check
-- (shows-the-thing.ts): a picture that shows the record, or none. Dated at
-- the epoch, like the backfill, so a record made a moment ago goes first.
--
-- Only `suggested` rows. A picture someone said Use it to, or that the
-- workspace applied, is on the record and is the record's own now; a No
-- thanks stays a No thanks.
--
-- manual recovery if this fails partway: nothing to undo; a row left
-- `suggested` keeps its old picture until it is answered.

-- First, one row per record. A record in a collection was saved under the
-- collection's kind name by one door and its module's by another, and each
-- name got a row: one "suggested", one "none", and every open of the record
-- read whichever came back first. Kept: an answer (Use it, No thanks) over
-- everything, then a waiting picture, then a search under way, then none
-- found; the newest of equals.
DELETE FROM core_scan_record_photo_suggestions a
 USING core_scan_record_photo_suggestions b
 WHERE a.entity_id = b.entity_id
   AND a.entity_kind <> b.entity_kind
   AND (
     (CASE a.status WHEN 'applied' THEN 0 WHEN 'declined' THEN 0 WHEN 'suggested' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
      b.updated_at, b.entity_kind)
     >
     (CASE b.status WHEN 'applied' THEN 0 WHEN 'declined' THEN 0 WHEN 'suggested' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
      a.updated_at, a.entity_kind)
   );

UPDATE core_scan_record_photo_suggestions
   SET status = 'queued', attempts = 0, file_id = NULL, source_url = NULL, updated_at = to_timestamp(0)
 WHERE status = 'suggested';
