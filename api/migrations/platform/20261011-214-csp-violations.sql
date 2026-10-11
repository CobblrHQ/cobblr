-- Content-Security-Policy refusals, counted (#3300). The app's policy is now
-- enforced and its report-uri is /api/v1/csp-reports, so each refusal a browser
-- makes lands here as one (day, directive, blocked source, page) with a count:
-- a source the policy forgot shows up for the operator, not only in one
-- person's console. Rows are already folded (origins, not URLs; ids and tokens
-- out of page paths) before they are written. Additive.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS csp_violations;
--   DELETE FROM migrations WHERE name = '20261011-214-csp-violations.sql';

create table if not exists csp_violations (
  day text not null,
  directive text not null,
  blocked text not null,
  page text not null,
  count integer not null default 1,
  last_seen timestamptz not null default now(),
  primary key (day, directive, blocked, page)
);
