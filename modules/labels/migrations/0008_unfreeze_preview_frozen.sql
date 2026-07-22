-- Heal the preview-freeze bug.
--
-- `/render` (the label PREVIEW endpoint) rendered through renderRowsToPdf, which
-- froze the code prefixes as a side effect — so a prefix locked the FIRST time a
-- user previewed labels, before ever printing. Reported by a user whose location
-- and printer codes were locked though they never hit print (2026-07-22). Fixed in
-- code: rendering no longer freezes; only a recorded print (POST /print, /record,
-- auto-flush) does.
--
-- This unfreezes every prefix frozen WITHOUT a real print. A prefix is legitimately
-- frozen only if a label under its kind was actually printed, i.e. a labels_prints
-- row exists (entity_kind = module_name:entity_type). Idempotent — safe to re-run,
-- and after the code fix nothing re-freezes a preview.
UPDATE labels_code_prefixes p
   SET frozen = false
 WHERE p.frozen = true
   AND NOT EXISTS (
     SELECT 1
       FROM labels_prints pr
      WHERE pr.module_name || ':' || pr.entity_type = p.entity_kind
   );
