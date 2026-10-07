-- Returns as records on their order (#4250).
--
-- A return lived only as stage entries appended to metadata.returns[] by the
-- email ingest: nothing showed it, nobody could start one, and neither the
-- shelf nor the spend ever heard of it. Each return is now a row tied to its
-- order (and its line, when known), carrying its furthest stage, the refund,
-- and two stamps that make the consequences happen once: stock_returned_at
-- (the count left the shelf) and refunded_at (the refund came off the spend).
--
-- The stage entries already on orders are moved in, one row per order and
-- item. Their consequences are history, not news: stock_returned_at is set on
-- every moved row so none removes stock it may never have known about, while a
-- refund the store already issued does come off that order's spend. Additive;
-- metadata.returns is left where it was.

create table if not exists purchases_returns (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchases_orders(id) on delete cascade,
  line_id uuid references purchases_order_items(id) on delete set null,
  item text,
  qty numeric not null default 1 check (qty > 0),
  reason text,
  stage text not null default 'requested'
    check (stage in ('requested', 'dropped_off', 'received', 'refunded', 'cancelled')),
  refund_amount numeric check (refund_amount is null or refund_amount >= 0),
  refunded_at timestamptz,
  stock_returned_at timestamptz,
  -- Moved in from metadata.returns: its stamp records nothing this table did,
  -- so undoing it never puts stock back.
  moved_in boolean not null default false,
  steps jsonb not null default '[]'::jsonb,
  created_by uuid,
  instance text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists purchases_returns_order_idx on purchases_returns (order_id);

insert into purchases_returns (order_id, item, stage, refund_amount, refunded_at, stock_returned_at, moved_in, steps, instance, created_at, updated_at)
select o.id,
       nullif(e.item, ''),
       -- furthest stage; a cancellation outranks the steps before the store had it
       (array_agg(e.stage order by case when e.stage = 'cancelled' then 2.5 else e.rank end desc))[1],
       max(e.refund_amount),
       case when bool_or(e.stage = 'refunded') then max(e.at) end,
       now(),
       true,
       jsonb_agg(jsonb_build_object('stage', e.stage, 'at', e.at, 'source', 'email') order by e.at),
       o.instance,
       min(e.at),
       now()
  from purchases_orders o
  cross join lateral (
    select coalesce(r->>'item', '') as item,
           r->>'stage' as stage,
           case r->>'stage' when 'requested' then 1 when 'dropped_off' then 2 when 'received' then 3 when 'refunded' then 4 else 0 end as rank,
           nullif(r->>'refund_amount', '')::numeric as refund_amount,
           coalesce(nullif(r->>'at', '')::timestamptz, o.updated_at) as at
      from jsonb_array_elements(case when jsonb_typeof(o.metadata->'returns') = 'array' then o.metadata->'returns' else '[]'::jsonb end) r
     where r->>'stage' in ('requested', 'dropped_off', 'received', 'refunded', 'cancelled')
  ) e
 where not exists (select 1 from purchases_returns x where x.order_id = o.id)
 group by o.id, e.item, o.instance;
