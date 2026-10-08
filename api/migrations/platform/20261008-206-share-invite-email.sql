-- A share invite can be for one email address (#5365). The owner types the
-- person's email; the invite is sent there when this Cobblr has outgoing mail,
-- and the link pairs only with an account that has that address. Empty for a
-- link made with no email, which stays open to whoever holds it.
-- invite_emailed_at counts the invite emails a workspace sent, so a burst of
-- them is refused per workspace, across restarts.
-- Additive: both columns are nullable and existing invites keep working.
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS invite_email text;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS invite_emailed_at timestamptz;
CREATE INDEX IF NOT EXISTS share_links_invite_emails_sent ON share_links (org_id, invite_emailed_at) WHERE invite_emailed_at IS NOT NULL;
