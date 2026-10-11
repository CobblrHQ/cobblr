-- Where a service visit happens (#5317): the registration renewal at the MVC,
-- the car's service at the garage. One JSON value read through
-- @cobblr/platform-contract/address; the visit's calendar event takes it as
-- its LOCATION. Nullable and additive.
alter table core_maintenance_entries
  add column if not exists address jsonb;
