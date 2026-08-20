-- Commands a workspace has ADOPTED: things it can do without an AI, learned
-- from a time an AI did them.
--
-- The candidates are derived on the fly from the change ledger (GET
-- /basics/learned) and deliberately not stored: a worked example is only a
-- suggestion until a person says "yes, that is a thing we do". This table is
-- what they said yes to.
--
-- The PATTERN is the contract. A command binds a message and produces writes,
-- so the server re-binds from these columns on every run and never trusts
-- operations sent by a client.
create table if not exists core_ai_commands (
  id           uuid primary key default gen_random_uuid(),
  -- "make rack {from} through {to} in {parent}" — what a person reads.
  template     text not null,
  -- The anchored regex, one capture group per slot, in slot order.
  pattern      text not null,
  slots        jsonb not null default '[]',
  -- The operations, with {slot} references where the example had literals.
  plan         jsonb not null,
  -- Set for a command that repeats over a range: which field counts, and the
  -- shape around the counter ("Rack {n}").
  repeat_field text,
  repeat_shape text,
  enabled      boolean not null default true,
  times_used   integer not null default 0,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- One command per template: adopting the same candidate twice is the same
-- command, not two that race to match the same sentence.
create unique index if not exists core_ai_commands_template
  on core_ai_commands (template);
