-- Who set the order's tracking number (orders never recorded a creator at
-- all, so this is the only ownership signal they have). Nullable: legacy rows
-- fall back to notifying every member, which is what happened before.
alter table purchases_orders
  add column if not exists tracking_added_by_user_id uuid;
