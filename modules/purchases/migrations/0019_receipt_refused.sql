-- A receipt whose stock write was refused for good (#7407).
--
-- A received line for a part marked gone, or deleted, was retried every
-- minute forever: the refusal cannot clear on its own. Such a line now hands
-- the question to a person as an unconfirmed line (0010), and this says why,
-- so they read the refusal beside the Add / Already counted choice. Set, it
-- also means the line's spend was already told, so adding the stock later
-- moves the shelf and nothing else.
--
-- A delivery that fails for another reason is retried with a backoff that
-- doubles from a minute up to six hours; `attempts` counts the tries.
-- Additive, with a default.

alter table purchases_order_items
  add column if not exists receipt_refused text;

alter table purchases_receive_outbox
  add column if not exists attempts integer not null default 0;
