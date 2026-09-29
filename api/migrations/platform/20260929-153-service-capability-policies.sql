-- A workspace's say over each service capability (docs/design-decisions/
-- services.md section 9): run it, always ask, or never. No row is the
-- default, which is the capability's own effect deciding. `run` relaxes a
-- capability that writes; it never relaxes one that spends or acts in the
-- physical world, and the rule that reads this (service-consent.ts) holds
-- that, not this table. Keyed by workspace in meta, so every workspace has it
-- from the moment this runs. Additive.
CREATE TABLE IF NOT EXISTS service_capability_policies (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability LIKE '%.%'),
  policy text NOT NULL CHECK (policy IN ('always_ask', 'run', 'off')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, capability)
);
