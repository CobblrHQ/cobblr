-- Pair every successful write with the message that asked for it.
--
-- The ledger already recorded what Ask Cobb DID (tool, kind, payload) but not
-- what it was asked, so the two halves of a worked example were never in the
-- same place. That made the obvious question unanswerable: which sentences
-- reliably produce which operations, and which of those could a workspace run
-- again WITHOUT an AI?
--
-- Additive and nullable: an older api ignores it, and rows written before this
-- simply have no prompt, which reads correctly as "we do not know".
alter table core_ai_chat_writes
  add column if not exists prompt text;

-- One message often produces several writes (twelve racks from one sentence).
-- Grouping by turn is what turns those into ONE example rather than twelve.
alter table core_ai_chat_writes
  add column if not exists turn_id uuid;

create index if not exists core_ai_chat_writes_turn
  on core_ai_chat_writes (turn_id) where turn_id is not null;
