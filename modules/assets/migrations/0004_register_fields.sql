-- What an asset register keeps beside the name: what it cost and where it
-- came from, so a garage or an office can say what it is worth and where to
-- go for another. Additive and nullable: an asset nobody priced has no price.

alter table assets_assets add column if not exists purchase_price_cents integer default null;
alter table assets_assets add column if not exists vendor text default null;
