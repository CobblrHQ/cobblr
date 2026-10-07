alter table share_offers alter column link_id drop not null;
alter table share_offers add column if not exists target_org_id uuid references orgs(id) on delete cascade;
alter table share_offers add column if not exists transfer jsonb;
create index if not exists share_offers_target_org_idx on share_offers(target_org_id) where target_org_id is not null;
create unique index if not exists share_offers_send_step_idx on share_offers(batch, (source->>'id')) where target_org_id is not null;
