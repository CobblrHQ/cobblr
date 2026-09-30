-- One send per job. A send claims the job (send_token, send_claimed_at) in one
-- conditional UPDATE before it talks to the printer; a second send of the
-- same job (a double tap, a retry, an assistant and a person, two tabs) finds
-- the claim taken and is refused, so the printer is never handed the same job
-- twice. The token also rides to the manager as the submit's idempotency key.
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS send_token uuid;
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS send_claimed_at timestamptz;
