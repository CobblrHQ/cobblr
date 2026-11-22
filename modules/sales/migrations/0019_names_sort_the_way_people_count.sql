-- Names sort the way people count and read (#9713): numbers by their value
-- (M2, M8, M10), accented letters among their own (É with E), case ignored.
-- The list queries order through cobblr_natural (byName, orderKey and
-- nameAfter in @cobblr/platform-contract/name-order). It is ICU's root
-- collation with numeric ordering; a cluster built without ICU gets one that
-- sorts as before, by byte, so the queries that name it always run. Every
-- module that sorts by name creates it the same way if it is not there yet,
-- and two doing it at once leave one.
do $$
begin
  if not exists (select 1 from pg_collation where collname = 'cobblr_natural' and collnamespace = 'public'::regnamespace) then
    begin
      create collation public.cobblr_natural (provider = icu, locale = 'und-u-kn-true');
    exception
      when duplicate_object then null;
      when others then
        begin
          create collation public.cobblr_natural from "C";
        exception when duplicate_object then null;
        end;
    end;
  end if;
end $$;

-- The list pages by name; ordered by the collation, this keeps it an index read.
create index if not exists sales_customers_name_natural on sales_customers (name collate cobblr_natural, id);
