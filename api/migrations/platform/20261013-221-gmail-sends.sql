-- A workspace sends its email from a Gmail account (#6070, slice 3d).
--
-- The owner: bring your own sender, and Gmail is one a household already
-- has. Connected through Google's consent screen with only the send scope;
-- the grant's refresh token is in config_enc like every other provider's
-- secret.
--
-- Additive + safe: the provider check gains one value; every row that
-- passed it still does.
--
-- manual recovery if this fails partway:
--   ALTER TABLE org_outbound_email DROP CONSTRAINT IF EXISTS org_outbound_email_provider_check;
--   ALTER TABLE org_outbound_email ADD CONSTRAINT org_outbound_email_provider_check
--     CHECK (provider in ('smtp', 'mailgun', 'resend', 'postmark'));
--   DELETE FROM migrations WHERE name = '20261013-221-gmail-sends.sql';

alter table org_outbound_email drop constraint if exists org_outbound_email_provider_check;
alter table org_outbound_email add constraint org_outbound_email_provider_check
  check (provider in ('smtp', 'mailgun', 'resend', 'postmark', 'gmail'));
