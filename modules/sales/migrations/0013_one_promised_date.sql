-- Keep the native deadline authoritative while accepting the older bundle field.
create function sales_promised_date() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    if new.due_date is null and new.metadata ? 'due_date' then
      new.due_date := nullif(new.metadata->>'due_date', '')::date;
    end if;
  elsif new.due_date is not distinct from old.due_date
    and new.metadata ? 'due_date'
    and new.metadata->'due_date' is distinct from old.metadata->'due_date' then
    new.due_date := nullif(new.metadata->>'due_date', '')::date;
  end if;
  if new.metadata ? 'due_date' and (
    new.due_date is not null
    or nullif(new.metadata->>'due_date', '') is null
    or (TG_OP = 'UPDATE' and new.due_date is distinct from old.due_date)
  ) then
    new.metadata := jsonb_set(new.metadata, '{due_date}', coalesce(to_jsonb(to_char(new.due_date, 'YYYY-MM-DD')), 'null'::jsonb));
  end if;
  return new;
end;
$$;
create trigger sales_promised_date before insert or update on sales_orders
for each row execute function sales_promised_date();

-- Existing contradictory dates keep the native deadline used by reminders.
-- Invalid legacy text stays intact for recovery instead of blocking upgrades.
do $$
declare r record; promised date;
begin
  for r in select id, due_date, metadata from sales_orders where metadata ? 'due_date' loop
    begin
      promised := coalesce(r.due_date, nullif(r.metadata->>'due_date', '')::date);
      update sales_orders set due_date = promised where id = r.id;
    exception when invalid_datetime_format or datetime_field_overflow then
      continue;
    end;
  end loop;
end;
$$;
